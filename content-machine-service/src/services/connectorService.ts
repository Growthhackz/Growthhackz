import { get } from '../db/database.js';
import { CHAINS } from '../domain/schemas.js';
import { ValidationError } from '../lib/errors.js';
import { tokenPairs } from '../providers/dexscreener.js';
import { listModels } from '../providers/gemini.js';
import { telegram } from '../providers/telegram.js';
import { accountInfo } from '../providers/telegraph.js';
import { nowMs, type ServiceContext } from './context.js';
import { rawSetting, setting, type SettingKey } from './settingsService.js';

interface Source {
  id: string;
  name: string;
  mode: string;
  credential: SettingKey | null;
  detail: string;
  url?: string;
}

/** Every source the product has discussed, with the direction actually implemented. Planned/handoff ones do nothing automatically. */
export const SOURCES: Source[] = [
  { id: 'dexscreener', name: 'DEX Screener', mode: 'fetch', credential: null, detail: 'Token pairs and market metadata by chain and contract.' },
  { id: 'helius', name: 'Helius / Solana metadata', mode: 'planned fetch', credential: null, detail: 'Secondary token metadata and conflict checks need a Helius project key.' },
  { id: 'gemini', name: 'Gemini', mode: 'generate', credential: 'GEMINI_API_KEY', detail: 'Structured copy and campaign/sticker artwork.' },
  { id: 'telegraph', name: 'Telegraph', mode: 'fetch + publish', credential: 'TELEGRAPH_TOKEN', detail: 'Read the connected account and publish verified project articles.' },
  { id: 'telegram', name: 'Telegram', mode: 'fetch + publish', credential: 'TELEGRAM_BOT_TOKEN', detail: 'Read bot identity, post to authorized chats and create sticker packs.' },
  { id: 'binance', name: 'Binance Square', mode: 'publish + verify', credential: null, detail: 'Official Square script on the companion worker; credentials stay on that worker.' },
  { id: 'paragraph', name: 'Paragraph', mode: 'planned fetch + publish', credential: null, detail: 'Publication API candidate; requires a publication key and a current API contract test.', url: 'https://docs.paragraph.com/developers' },
  { id: 'peak', name: 'Peak Buybot', mode: 'receive + push', credential: null, detail: 'Authenticated order intake, polling and signed delivery callbacks.' },
  { id: 'x', name: 'X', mode: 'draft + handoff', credential: null, detail: 'Three prepared posts; account posting needs user-context API access and is not active.' },
  { id: 'coinranking', name: 'Coinranking', mode: 'submission handoff', credential: null, detail: 'Token listing form with external review; not an automatic publication.', url: 'https://coinranking.com/coin-listing' },
  { id: 'coinvote', name: 'Coinvote', mode: 'submission handoff', credential: null, detail: 'Official coin submission flow; account review and visibility are external.', url: 'https://coinvote.cc/' },
  { id: 'degenz', name: 'DegenZ newsroom', mode: 'planned PR publish', credential: null, detail: 'Default PR route pending newsroom endpoint and editorial authorization.' },
  { id: 'cmc', name: 'CoinMarketCap', mode: 'submission handoff', credential: null, detail: 'Official listing request form; review and approval happen on CoinMarketCap.', url: 'https://support.coinmarketcap.com/hc/en-us/requests/new' },
];

export function connectorList(ctx: ServiceContext) {
  const lastSeen = Number(rawSetting(ctx, 'renderer_last_seen') || 0);
  const workerOnline = !!lastSeen && nowMs(ctx) - lastSeen < ctx.config.RENDERER_STALE_MS;
  const hasKey = !!get(ctx.db, 'SELECT id FROM api_keys WHERE revoked_at IS NULL LIMIT 1');
  return SOURCES.map((s) => {
    let status: string;
    if (s.id === 'dexscreener') status = 'ready';
    else if (s.credential) status = setting(ctx, s.credential) ? 'configured' : 'needs_key';
    else if (s.id === 'binance') status = workerOnline ? 'worker_online' : 'needs_worker';
    else if (s.id === 'peak') status = hasKey ? 'api_key_created' : 'needs_api_key';
    else if (s.mode.startsWith('planned')) status = 'planned';
    else status = 'handoff';
    return { ...s, status, last_seen: s.id === 'binance' && lastSeen ? new Date(lastSeen).toISOString() : null };
  });
}

/** Read-only checks. They never publish or spend generation allowance. */
export async function probeConnector(ctx: ServiceContext, id: string, input: Record<string, unknown> = {}) {
  switch (id) {
    case 'dexscreener': {
      const { chain, contract_address } = input;
      if (!CHAINS.includes(chain as never) || typeof contract_address !== 'string' || !/^[a-zA-Z0-9]{20,64}$/.test(contract_address))
        throw new ValidationError('Supply a valid chain and contract address to fetch token data.');
      const pairs = await tokenPairs(ctx, chain as string, contract_address);
      return {
        ok: true,
        pairs: pairs.slice(0, 5).map((p) => ({ name: p.baseToken?.name, symbol: p.baseToken?.symbol, url: p.url, liquidity_usd: p.liquidity?.usd })),
      };
    }
    case 'gemini':
      return listModels(ctx);
    case 'telegraph':
      return { ok: true, account: await accountInfo(ctx) };
    case 'telegram': {
      const bot = await telegram(ctx, 'getMe', {});
      return { ok: true, bot: { id: bot.id, username: bot.username, can_join_groups: bot.can_join_groups } };
    }
    case 'binance':
    case 'peak':
      return { ok: true, connectors: connectorList(ctx).filter((s) => s.id === id) };
  }
  throw new ValidationError('This source uses a reviewed handoff rather than an API probe.');
}
