// Other platforms' trending lists, read from their public feeds (no logins, no bot-check workarounds).
//
//   pump      Pump.fun "Now trending"          frontend-api-v3.pump.fun/coins/great-coins   (what pump.fun's own page uses)
//   jupiter   Jupiter top trending, 1h         lite-api.jup.ag/tokens/v2/toptrending/1h     (memecoins only: launchpad or meme tag)
//   gecko     GeckoTerminal trending, Solana   api.geckoterminal.com .../trending_pools     (official free API)
//   dexboost  DexScreener most boosted         api.dexscreener.com/token-boosts/top/v1      (official API; boosts are paid promotion)
//
// GMGN, DEXTools, Axiom and DexScreener's trending page sit behind Cloudflare bot checks or wallet logins. They are
// probed with one ordinary request every 15 minutes so the page can show their real status; nothing tries to get past them.

const SOL_SKIP = new Set(['So11111111111111111111111111111111111111112', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB']);

export function createSources({ getJson, geckoLimited }) {
  const boards = {
    pump:     { id: 'pump',     name: 'Pump.fun',      label: 'Now trending',     link: 'https://pump.fun',                          status: 'loading', items: [] },
    jupiter:  { id: 'jupiter',  name: 'Jupiter',       label: 'Top trending 1h',  link: 'https://jup.ag',                            status: 'loading', items: [] },
    gecko:    { id: 'gecko',    name: 'GeckoTerminal', label: 'Trending · Solana', link: 'https://www.geckoterminal.com/solana/pools', status: 'loading', items: [] },
    dexboost: { id: 'dexboost', name: 'DexScreener',   label: 'Most boosted',     link: 'https://dexscreener.com',                   status: 'loading', items: [] },
  };
  const blocked = {
    gmgn:     { id: 'gmgn',     name: 'GMGN',        label: 'Trending',       link: 'https://gmgn.ai/?chain=sol',            probe: 'https://gmgn.ai/defi/quotation/v1/rank/sol/swaps/1h?orderby=swaps&direction=desc' },
    dextools: { id: 'dextools', name: 'DEXTools',    label: 'Hot pairs',      link: 'https://www.dextools.io/app/en/solana/pool-explorer', probe: 'https://www.dextools.io/shared/hotpairs/hot?chain=solana' },
    axiom:    { id: 'axiom',    name: 'Axiom',       label: 'Trending',       link: 'https://axiom.trade',                   probe: 'https://api6.axiom.trade/meme-trending?timePeriod=1h' },
    dexscr:   { id: 'dexscr',   name: 'DexScreener', label: 'Trending page',  link: 'https://dexscreener.com/solana',        probe: 'https://dexscreener.com/solana?rankBy=trendingScoreH6&order=desc' },
  };
  for (const b of Object.values(blocked)) Object.assign(b, { status: 'checking', items: [], note: '' });

  const set = (b, items) => { b.items = items.slice(0, 10).map((x, i) => ({ rank: i + 1, ...x })); b.status = 'live'; b.updatedAt = Date.now(); b.note = ''; };
  const fail = (b, e) => { b.status = b.items.length ? 'stale' : 'error'; b.note = String(e?.message || e).slice(0, 120); };

  async function pump() {
    const j = await getJson('https://frontend-api-v3.pump.fun/coins/great-coins');
    set(boards.pump, (Array.isArray(j) ? j : []).filter(c => c?.mint).map(c => ({
      chain: 'solana', address: c.mint, symbol: c.symbol, name: c.name, icon: c.image_uri || null, mcap: c.usd_market_cap ?? null,
    })));
  }
  async function jupiter() {
    const j = await getJson('https://lite-api.jup.ag/tokens/v2/toptrending/1h?limit=50');
    // memecoins only: launched on a launchpad or tagged meme; no stocks, RWAs, DeFi tokens or wrapped assets
    const NOT_MEME = new Set(['stocks', 'xstocks', 'rwa', 'equities', 'defi', 'stablecoin', 'lst']);
    const isMeme = t => t?.id && !SOL_SKIP.has(t.id) && (t.mcap ?? 0) < 1e9 && !/wrapped|bridged/i.test(t.name || '')
      && !(t.tags || []).some(x => NOT_MEME.has(x)) && (t.launchpad || (t.tags || []).includes('meme'));
    const memes = (Array.isArray(j) ? j : []).filter(isMeme);
    set(boards.jupiter, memes.map(t => ({ chain: 'solana', address: t.id, symbol: t.symbol, name: t.name, icon: t.icon || null, mcap: t.mcap ?? null, ch1h: t.stats1h?.priceChange ?? null })));
  }
  async function gecko() {
    const j = await geckoLimited('https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?duration=1h', 'high');
    const seen = new Set(), items = [];
    for (const p of j?.data || []) {
      const addr = (p.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
      if (!addr || SOL_SKIP.has(addr) || seen.has(addr)) continue;
      seen.add(addr);
      const a = p.attributes || {};
      items.push({ chain: 'solana', address: addr, symbol: (a.name || '').split(' / ')[0], name: a.name, icon: null, mcap: Number(a.market_cap_usd || a.fdv_usd) || null, ch1h: a.price_change_percentage?.h1 != null ? Number(a.price_change_percentage.h1) : null });
    }
    set(boards.gecko, items);
  }
  async function dexboost() {
    const j = await getJson('https://api.dexscreener.com/token-boosts/top/v1');
    const seen = new Set();
    set(boards.dexboost, (Array.isArray(j) ? j : []).filter(t => t?.tokenAddress && !seen.has(t.chainId + t.tokenAddress) && seen.add(t.chainId + t.tokenAddress)).map(t => ({
      chain: t.chainId, address: t.tokenAddress, symbol: null, name: null, icon: t.icon ? `https://cdn.dexscreener.com/cms/images/${t.icon}?width=160&height=160&quality=95&format=auto` : null, boosts: t.totalAmount ?? null,
    })));
  }
  async function probe(b) {
    try {
      const r = await fetch(b.probe, { headers: { accept: 'application/json, text/html', 'user-agent': 'peak-ridge/0.1 (+https://peak-ridge-web-production.up.railway.app)' } });
      const text = await r.text();
      if (r.ok && /^\s*[{[]/.test(text)) { b.status = 'reachable'; b.note = 'Answered; not parsed yet'; }
      else if (/just a moment|cf-chl|cloudflare/i.test(text) || r.status === 403) { b.status = 'blocked'; b.note = 'Behind a Cloudflare bot check'; }
      else if (r.status === 401 || r.status === 425) { b.status = 'blocked'; b.note = 'Needs a logged-in wallet session'; }
      else { b.status = 'blocked'; b.note = `HTTP ${r.status}`; }
    } catch (e) { b.status = 'blocked'; b.note = 'No answer'; }
    b.updatedAt = Date.now();
  }

  const every = (fn, ms, b) => { const run = () => fn().catch(e => fail(b, e)); run(); setInterval(run, ms); };
  every(pump, 20_000, boards.pump);
  every(jupiter, 30_000, boards.jupiter);
  every(gecko, 60_000, boards.gecko);
  every(dexboost, 60_000, boards.dexboost);
  const probeAll = () => Object.values(blocked).forEach(b => probe(b));
  probeAll(); setInterval(probeAll, 15 * 60_000);

  return { boards, blocked };
}
