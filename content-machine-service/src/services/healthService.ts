import { listModels } from '../providers/gemini.js';
import { socialActivity } from '../providers/socialActivity.js';
import { botToken, telegram } from '../providers/telegram.js';
import { ValidationError } from '../lib/errors.js';
import { nowMs, type ServiceContext } from './context.js';
import { isPaused } from './pauseService.js';
import { rawSetting, setRawSetting, setting } from './settingsService.js';

/**
 * Source health, so a broken login or an empty wallet is found before an order needs it. The worker checks the sites
 * it posts to (logins, forms); the API checks its own keys, bots and the WURK wallet. Every change between working
 * and broken is sent to the admins on Telegram.
 */
export interface SourceCheck {
  source: string;
  ok: boolean;
  detail: string;
  checked_at: string;
  by: 'worker' | 'api';
}

const KEY = 'source_health';
const API_RUN_KEY = 'source_health_api_at';
export const HEALTH_INTERVAL_MS = 30 * 60_000;
/** The worker polls for work every few seconds; this long without a claim means it is down. */
const WORKER_SILENT_MS = 10 * 60_000;

export function sourceHealth(ctx: ServiceContext): Record<string, SourceCheck> {
  try {
    return JSON.parse(rawSetting(ctx, KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Stores checks and alerts the admins about anything that changed (a first check alerts only when broken). */
export async function recordChecks(ctx: ServiceContext, input: unknown, by: SourceCheck['by']): Promise<Record<string, SourceCheck>> {
  if (!Array.isArray(input) || input.length > 40) throw new ValidationError('checks must be a list');
  const checks = input.map((c) => {
    const x = c as { source?: unknown; ok?: unknown; detail?: unknown };
    if (typeof x.source !== 'string' || !/^[a-z0-9_]{2,40}$/.test(x.source) || typeof x.ok !== 'boolean')
      throw new ValidationError('Each check needs a source and ok');
    return { source: x.source, ok: x.ok, detail: String(x.detail ?? '').slice(0, 300) };
  });
  const all = sourceHealth(ctx);
  const changed: SourceCheck[] = [];
  for (const c of checks) {
    const before = all[c.source];
    const next: SourceCheck = { ...c, checked_at: new Date(nowMs(ctx)).toISOString(), by };
    if (before ? before.ok !== c.ok : !c.ok) changed.push(next);
    all[c.source] = next;
  }
  setRawSetting(ctx, KEY, JSON.stringify(all));
  if (changed.length) await alertAdmins(ctx, changed);
  return all;
}

const NAMES: Record<string, string> = {
  cmc: 'CoinMarketCap',
  bitcointalk: 'Bitcointalk',
  gemfinder: 'GemFinder',
  freshcoins: 'FreshCoins',
  coinscope: 'Coinscope',
  top100token: 'Top100Token',
  binance: 'Binance Square',
  gemini: 'Gemini (copy and images)',
  sticker_bot: 'Sticker bot',
  telegraph: 'Telegraph',
  wurk: 'WURK social boost',
  worker: 'Companion worker',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function alertAdmins(ctx: ServiceContext, changed: SourceCheck[]) {
  const chat = setting(ctx, 'ASSIST_CHAT_ID') || setting(ctx, 'STICKER_OWNER_ID');
  if (!chat) return;
  const lines = changed.map((c) => `${c.ok ? '🟢' : '🔴'} <b>${esc(NAMES[c.source] ?? c.source)}</b>: ${c.ok ? 'working again' : esc(c.detail || 'not working')}`);
  try {
    await telegram(ctx, 'sendMessage', { chat_id: chat, text: ['<b>Content machine sources</b>', ...lines].join('\n'), parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'source health alert not sent');
  }
}

const result = async (source: string, fn: () => Promise<string>) => {
  try {
    return { source, ok: true, detail: await fn() };
  } catch (err) {
    return { source, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
};

/** The API's own checks, at most every HEALTH_INTERVAL_MS (called from the scheduler's tick). */
export async function apiHealthChecks(ctx: ServiceContext, force = false): Promise<void> {
  const last = Number(rawSetting(ctx, API_RUN_KEY) ?? 0);
  if (!force && nowMs(ctx) - last < HEALTH_INTERVAL_MS) return;
  setRawSetting(ctx, API_RUN_KEY, String(nowMs(ctx)));
  const checks = await Promise.all([
    result('gemini', async () => {
      await listModels(ctx);
      return 'key works';
    }),
    result('sticker_bot', async () => {
      botToken(ctx);
      const me = await telegram(ctx, 'getMe', {});
      return `@${me.username}`;
    }),
    result('telegraph', async () => {
      const token = setting(ctx, 'TELEGRAPH_TOKEN');
      if (!token) return 'no token saved (one is created on first use)';
      const r = (await (await ctx.http(`https://api.telegra.ph/getAccountInfo?access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15_000) })).json()) as { ok?: boolean; error?: string };
      if (!r.ok) throw new Error(`Telegraph token rejected: ${r.error ?? 'unknown'}`);
      return 'token works';
    }),
    result('worker', async () => {
      if (isPaused(ctx)) return 'paused';
      const seen = Number(rawSetting(ctx, 'renderer_last_seen') ?? 0);
      if (nowMs(ctx) - seen > WORKER_SILENT_MS) throw new Error(`no contact for ${Math.round((nowMs(ctx) - seen) / 60_000)} min (redeploy content-machine-worker)`);
      return 'polling';
    }),
    ...(ctx.config.SOCIAL_ACTIVITY_URL
      ? [
          result('wurk', async () => {
            const st = await socialActivity<{ liveReady: boolean; missingForLive: string[]; usdcBalance: number | null; walletError: string | null }>(ctx, 'GET', '/v1/wurk/status');
            if (st.walletError) throw new Error(st.walletError);
            if (!st.liveReady) throw new Error(`live payments off (${st.missingForLive.join(', ')})`);
            if (st.usdcBalance === null) throw new Error('wallet balance could not be read');
            if (st.usdcBalance < ctx.config.WURK_LOW_BALANCE_USDC) throw new Error(`wallet has ${st.usdcBalance.toFixed(2)} USDC; top it up (each order uses about 4)`);
            return `${st.usdcBalance.toFixed(2)} USDC`;
          }),
        ]
      : []),
  ]);
  await recordChecks(ctx, checks, 'api');
}
