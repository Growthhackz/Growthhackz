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
  /** Failed checks in a row (each failed check is also a fix attempt: re-login, retry). */
  fails?: number;
  /** ok → fixing (being retried automatically) → escalated (needs a person). */
  stage?: 'ok' | 'fixing' | 'escalated';
}

const KEY = 'source_health';
const API_RUN_KEY = 'source_health_api_at';
export const HEALTH_INTERVAL_MS = 30 * 60_000;
/** While something is broken it is rechecked (and re-logged-in) this often. */
export const FIXING_INTERVAL_MS = 5 * 60_000;
/** Failed fix attempts in a row before a person is asked. */
export const ESCALATE_AFTER = 3;
/** The worker polls for work every few seconds; this long without a claim means it is down. */
const WORKER_SILENT_MS = 10 * 60_000;

export function sourceHealth(ctx: ServiceContext): Record<string, SourceCheck> {
  try {
    return JSON.parse(rawSetting(ctx, KEY) ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Stores checks. A source that breaks is "fixing" (🟡: it is rechecked, and its login renewed, every few minutes);
 * one that comes back is "fixed" (✅); one still broken after ESCALATE_AFTER attempts is escalated (🔴, with what to
 * do). Each message goes out once per transition.
 */
export async function recordChecks(ctx: ServiceContext, input: unknown, by: SourceCheck['by']): Promise<Record<string, SourceCheck>> {
  if (!Array.isArray(input) || input.length > 40) throw new ValidationError('checks must be a list');
  const checks = input.map((c) => {
    const x = c as { source?: unknown; ok?: unknown; detail?: unknown };
    if (typeof x.source !== 'string' || !/^[a-z0-9_]{2,40}$/.test(x.source) || typeof x.ok !== 'boolean')
      throw new ValidationError('Each check needs a source and ok');
    return { source: x.source, ok: x.ok, detail: String(x.detail ?? '').slice(0, 300) };
  });
  const all = sourceHealth(ctx);
  const lines: string[] = [];
  for (const c of checks) {
    const before = all[c.source];
    const stage = before?.stage ?? (before && !before.ok ? 'fixing' : 'ok');
    const fails = c.ok ? 0 : (before?.fails ?? 0) + 1;
    let next: SourceCheck['stage'] = c.ok ? 'ok' : stage === 'escalated' ? 'escalated' : fails >= ESCALATE_AFTER ? 'escalated' : 'fixing';
    const name = `<b>${esc(NAMES[c.source] ?? c.source)}</b>`;
    if (c.ok && stage !== 'ok') lines.push(`✅ Fixed: ${name} is working again.`);
    else if (!c.ok && stage === 'ok') lines.push(`🟡 Caught: ${name}: ${esc(c.detail || 'not working')}. Working on it (rechecking and re-logging in every ${FIXING_INTERVAL_MS / 60_000} min).`);
    if (!c.ok && next === 'escalated' && stage !== 'escalated')
      lines.push(`🔴 Need you: ${name} still fails after ${fails} automatic attempts: ${esc(c.detail || 'not working')}. ${esc(MANUAL[c.source] ?? 'Check the service logs.')}`);
    if (c.ok) next = 'ok';
    all[c.source] = { ...c, checked_at: new Date(nowMs(ctx)).toISOString(), by, fails, stage: next };
  }
  setRawSetting(ctx, KEY, JSON.stringify(all));
  if (lines.length) await notifyAdmins(ctx, lines);
  return all;
}

/** True while any source owned by `by` is broken: its checks then run every FIXING_INTERVAL_MS. */
export function anyFixing(ctx: ServiceContext, by: SourceCheck['by']): boolean {
  return Object.values(sourceHealth(ctx)).some((c) => c.by === by && !c.ok);
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

/** What a person does when automatic fixing gave up (the 🔴 message). */
const MANUAL: Record<string, string> = {
  cmc: 'Log in to CoinMarketCap once in a normal browser, export the cookies and send them (CMC_COOKIES on the worker).',
  bitcointalk: 'Export fresh Bitcointalk cookies from a logged-in browser (BTCTALK_COOKIES on the worker).',
  gemfinder: 'Check the GemFinder login (GEMFINDER_EMAIL / GEMFINDER_PASSWORD on the worker).',
  freshcoins: 'Export fresh FreshCoins cookies from a logged-in browser (FRESHCOINS_COOKIES on the worker).',
  coinscope: 'Sign in to Coinscope again and copy the new refresh token (COINSCOPE_REFRESH_TOKEN on the worker).',
  top100token: 'Top100Token is blocking the worker (Cloudflare); it usually clears on its own.',
  binance: 'Check BINANCE_SQUARE_OPENAPI_KEY on the worker.',
  gemini: 'Check the Gemini API key and its quota.',
  sticker_bot: 'Check TELEGRAM_BOT_TOKEN (the sticker bot).',
  telegraph: 'Clear TELEGRAPH_TOKEN so a new one is created.',
  wurk: 'Top up the WURK wallet with USDC (or check WURK_LIVE_PAYMENTS_ENABLED).',
  worker: 'Redeploy content-machine-worker on Railway.',
};
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One Telegram message to the admins (ASSIST_CHAT_ID, else STICKER_OWNER_ID). Never throws. */
export async function notifyAdmins(ctx: ServiceContext, lines: string[]): Promise<boolean> {
  const chat = setting(ctx, 'ASSIST_CHAT_ID') || setting(ctx, 'STICKER_OWNER_ID');
  if (!chat || !lines.length) return false;
  try {
    await telegram(ctx, 'sendMessage', { chat_id: chat, text: ['<b>Content machine</b>', ...lines].join('\n'), parse_mode: 'HTML', disable_web_page_preview: true });
    return true;
  } catch (err) {
    ctx.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'admin message not sent');
    return false;
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
  if (!force && nowMs(ctx) - last < (anyFixing(ctx, 'api') ? FIXING_INTERVAL_MS : HEALTH_INTERVAL_MS)) return;
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
