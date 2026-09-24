import { get } from '../db/database.js';
import { CHAINS } from '../domain/schemas.js';
import { SetupRequiredError, ValidationError } from '../lib/errors.js';
import { tokenPairs } from '../providers/dexscreener.js';
import { listModels } from '../providers/gemini.js';
import { callChannelToken, telegram } from '../providers/telegram.js';
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

/**
 * Inputs (DEX Screener, Gemini, order intake) plus the only destinations we publish to.
 * `planned` destinations are listed so setup can be tracked; nothing posts to them yet.
 */
export const SOURCES: Source[] = [
  { id: 'dexscreener', name: 'DEX Screener', mode: 'input', credential: null, detail: 'Token name, ticker, logo and market data by chain and contract.' },
  { id: 'gemini', name: 'Gemini', mode: 'input', credential: 'GEMINI_API_KEY', detail: 'The three posts and the campaign/sticker artwork.' },
  { id: 'intake', name: 'Order intake', mode: 'receive + push', credential: null, detail: 'Authenticated order and trending intake, polling and signed callbacks.' },
  { id: 'binance', name: 'Binance Square article', mode: 'publish + verify', credential: null, detail: 'Article with the campaign image as cover, via the official Square script on the companion worker.' },
  { id: 'telegraph', name: 'Telegraph article', mode: 'publish + verify', credential: 'TELEGRAPH_TOKEN', detail: 'Article with the campaign image embedded (needs PUBLIC_HUB_ENABLED), then page verification.' },
  { id: 'call_channel', name: 'Full Send Trenches channel post', mode: 'publish', credential: 'CALL_CHANNEL_BOT_TOKEN', detail: 'X-sized post with the campaign image and the project Telegram link, posted by our bot to CALL_CHANNEL_ID.' },
  { id: 'sticker_pack', name: 'Telegram sticker pack', mode: 'publish + verify', credential: 'TELEGRAM_BOT_TOKEN', detail: 'Five stickers from the project mascot, published as a set owned by the project (needs telegram_owner_id).' },
  { id: 'reddit_moonshots', name: 'Reddit r/moonshots', mode: 'planned publish', credential: null, detail: 'Not built yet.', url: 'https://www.reddit.com/r/moonshots/' },
  { id: 'reddit_solanamemecoins', name: 'Reddit r/solanamemecoins', mode: 'planned publish', credential: null, detail: 'Not built yet.', url: 'https://www.reddit.com/r/solanamemecoins/' },
  { id: 'coinsniper', name: 'CoinSniper listing', mode: 'planned listing', credential: null, detail: 'Not built yet; account + browser automation.', url: 'https://coinsniper.net/' },
  { id: 'coinvote', name: 'Coinvote listing', mode: 'planned listing', credential: null, detail: 'Not built yet; account + browser automation.', url: 'https://coinvote.cc/' },
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
    else if (s.id === 'intake') status = hasKey ? 'api_key_created' : 'needs_api_key';
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
    case 'sticker_pack': {
      const bot = await telegram(ctx, 'getMe', {});
      return { ok: true, bot: { id: bot.id, username: bot.username, can_join_groups: bot.can_join_groups } };
    }
    case 'call_channel': {
      const token = callChannelToken(ctx);
      const channel = setting(ctx, 'CALL_CHANNEL_ID');
      if (!channel) throw new SetupRequiredError('Set CALL_CHANNEL_ID first.');
      const bot = await telegram(ctx, 'getMe', {}, token);
      const member = await telegram(ctx, 'getChatMember', { chat_id: channel, user_id: bot.id }, token);
      const canPost = ['administrator', 'creator'].includes(member.status) && (member.status === 'creator' || !!member.can_post_messages);
      return { ok: canPost, bot: bot.username, channel, status: member.status, can_post_messages: canPost };
    }
    case 'binance':
    case 'intake':
      return { ok: true, connectors: connectorList(ctx).filter((s) => s.id === id) };
  }
  throw new ValidationError('This source uses a reviewed handoff rather than an API probe.');
}
