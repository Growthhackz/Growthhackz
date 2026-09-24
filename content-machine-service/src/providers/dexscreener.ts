import type { Project } from '../domain/schemas.js';
import { SetupRequiredError } from '../lib/errors.js';
import { jsonFetch } from '../lib/http.js';
import { nowMs, type ServiceContext } from '../services/context.js';

const API = 'https://api.dexscreener.com/token-pairs/v1';

export async function tokenPairs(ctx: ServiceContext, chain: string, address: string): Promise<any[]> {
  const r = await jsonFetch(ctx.http, `${API}/${encodeURIComponent(chain)}/${encodeURIComponent(address)}`);
  return Array.isArray(r) ? r : [];
}

/** Fills name/symbol/logo from the deepest-liquidity pair; supplied values always win. */
export async function enrich(ctx: ServiceContext, project: Project, demo: boolean): Promise<Project> {
  const p: Project = { ...project };
  if (demo) return { ...p, name: p.name || 'Demo Project', symbol: p.symbol || 'DEMO', enriched_at: nowMs(ctx), source: 'Demo input' };
  const sameToken = (a?: string) =>
    p.chain === 'solana' ? a === p.contract_address : a?.toLowerCase() === p.contract_address.toLowerCase();
  const pairs = (await tokenPairs(ctx, p.chain, p.contract_address)).filter(
    (x) => x.chainId === p.chain && sameToken(x.baseToken?.address),
  );
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const pair = pairs[0];
  if (pair) {
    p.name = p.name || pair.baseToken.name;
    p.symbol = p.symbol || pair.baseToken.symbol;
    p.logo_url = p.logo_url || pair.info?.imageUrl;
    p.market = {
      liquidity_usd: pair.liquidity?.usd,
      volume_24h: pair.volume?.h24,
      pair_url: pair.url,
      source: 'DEX Screener',
      fetched_at: nowMs(ctx),
    };
    p.source = 'DEX Screener / supplied details';
  } else {
    p.source = 'Supplied details';
  }
  if (!p.name || !p.symbol) throw new SetupRequiredError('Token metadata was not found. Supply the project name and ticker.');
  return { ...p, enriched_at: nowMs(ctx) };
}
