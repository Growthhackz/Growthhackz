// Peak Ridge server: serves the page and keeps a live picture of Peak's top 10.
//   /api/board    Peak's top 10 (peakbuybot.com mirrors the Telegram board), joined with DexScreener live
//                 price, volume, liquidity and buys/sells, plus each coin's Peak Momentum score (momentum.js).
//   /api/candles  GeckoTerminal 1-minute candles for one pool (the page builds 5m/15m from them).
//   /api/stream   live push (server-sent events): "prices" every ~2.5s, the full "board" every 10s.
//   /health       for the host's health check.
// Prices: Solana coins come from Jupiter (updates every few seconds); other chains from DexScreener (~30s).
// A background loop refreshes the board every 10s, keeps 1m candles fresh for every coin, and records holder
// counts and scores over time so momentum can measure holder growth and whether a score is rising.
// No dependencies. Run: node server.mjs  (PORT defaults to 8787)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PORT = Number(process.env.PORT || 8787);
const HERE = path.dirname(fileURLToPath(import.meta.url));
await import('./momentum.js');
const Momentum = globalThis.PeakMomentum;
const tracker = Momentum.createTracker();
const PEAK = 'https://www.peakbuybot.com/api/discovery?chain=all';
const DEX = 'https://api.dexscreener.com/tokens/v1';
const JUP = 'https://lite-api.jup.ag/price/v3?ids=';
const GECKO = 'https://api.geckoterminal.com/api/v2/networks';
const BOARD_SIZE = 10;

const BOARD_TTL = 20_000;   // Peak's own site refreshes every 30s
const PRICE_TTL = 4_000;    // DexScreener allows ~300 req/min; we use ~45
const CANDLE_TTL = 75_000;  // GeckoTerminal allows 30 req/min on the free tier

const isEvm = chain => chain !== 'solana';
const sameAddr = (chain, a, b) => isEvm(chain) ? a.toLowerCase() === b.toLowerCase() : a === b;

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'peak-ridge/0.1' } });
  if (!r.ok) { const e = new Error(`${r.status} from ${new URL(url).host}`); e.status = r.status; throw e; }
  return r.json();
}

// Small cache that keeps serving the last good value when the upstream fails.
const cache = new Map();
async function cached(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value;
  if (hit?.pending) return hit.pending;
  const pending = load().then(
    value => { cache.set(key, { at: Date.now(), value }); return value; },
    err => { if (hit) { cache.set(key, { ...hit, pending: null }); return hit.value; } cache.delete(key); throw err; },
  );
  cache.set(key, { ...(hit || { at: 0 }), pending });
  return pending;
}

// GeckoTerminal: queued in order, at most 12 calls a minute (the free tier is shared per IP),
// and a 30s pause after any 429.
const geckoCalls = [];
let geckoChain = Promise.resolve();
let geckoPauseUntil = 0;
function geckoLimited(url) {
  const run = async () => {
    for (;;) {
      const now = Date.now();
      while (geckoCalls.length && now - geckoCalls[0] > 60_000) geckoCalls.shift();
      if (now < geckoPauseUntil) { await new Promise(r => setTimeout(r, geckoPauseUntil - now)); continue; }
      if (geckoCalls.length < 12) break;
      await new Promise(r => setTimeout(r, 60_000 - (now - geckoCalls[0]) + 50));
    }
    geckoCalls.push(Date.now());
    try { return await getJson(url); }
    catch (e) { if (e.status === 429) geckoPauseUntil = Date.now() + 30_000; throw e; }
  };
  const p = geckoChain.then(run, run);
  geckoChain = p.catch(() => {});
  return p;
}

async function loadPeak() {
  const j = await getJson(PEAK);
  const tokens = (Array.isArray(j.tokens) ? j.tokens : []).slice().sort((a, b) => a.rank - b.rank).slice(0, BOARD_SIZE);
  return { updatedAt: j.updatedAt, tokens };
}

async function loadMarket(tokens) {
  const byChain = {};
  for (const t of tokens) (byChain[t.chain] ||= []).push(t.mint);
  const out = {};
  await Promise.all(Object.entries(byChain).map(async ([chain, mints]) => {
    const pairs = await cached(`dex:${chain}:${mints.join(',')}`, PRICE_TTL, () => getJson(`${DEX}/${chain}/${mints.join(',')}`)).catch(() => []);
    for (const mint of mints) {
      // the deepest pool is the one the price and chart should follow
      const best = (pairs || []).filter(p => sameAddr(chain, p.baseToken?.address || '', mint))
        .sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (best) out[`${chain}:${mint}`] = best;
    }
  }));
  return out;
}

const smallImg = u => u ? u.replace(/width=\d+&height=\d+/, 'width=160&height=160') : null;

// Peak's token page lists the project's links and logo even when DexScreener has no listing yet.
// Only used for the top 3 when DexScreener lacks a logo or Telegram, cached for 10 minutes.
async function peakPageExtras(page) {
  return cached(`peakpage:${page}`, 600_000, async () => {
    const r = await fetch('https://www.peakbuybot.com' + page, { headers: { 'user-agent': 'peak-ridge/0.1' } });
    if (!r.ok) return {};
    const html = await r.text();
    const telegram = html.match(/class="link-row" href="(https:\/\/t\.me\/[A-Za-z0-9_+\/]+)"/)?.[1] || null;
    const icon = html.match(/property="og:image" content="(https:\/\/[^"]+)"/)?.[1] || null;
    return { telegram, icon: icon && !/peakbuybot\.com\/assets\//.test(icon) ? icon : null };
  }).catch(() => ({}));
}

async function board() {
  const peak = await cached('peak', BOARD_TTL, loadPeak);
  const market = await loadMarket(peak.tokens);
  const extras = {};
  await Promise.all(peak.tokens.slice(0, 3).map(async t => {
    const info = market[`${t.chain}:${t.mint}`]?.info;
    const hasTg = (info?.socials || []).some(x => x.type === 'telegram');
    if (t.page && (!hasTg || !(info?.imageUrl || t.icon))) extras[t.mint] = await peakPageExtras(t.page);
  }));
  return {
    updatedAt: peak.updatedAt,
    serverTime: Date.now(),
    tokens: peak.tokens.map(t => {
      const p = market[`${t.chain}:${t.mint}`];
      return {
        rank: t.rank, chain: t.chain, symbol: t.symbol, name: t.name, mint: t.mint,
        // logos come from DexScreener (Peak's own icon as fallback), asked for at a small size
        icon: smallImg(p?.info?.imageUrl || t.icon || extras[t.mint]?.icon || null),
        telegram: (p?.info?.socials || []).find(x => x.type === 'telegram' && /^https:\/\/t\.me\//.test(x.url || ''))?.url || extras[t.mint]?.telegram || null,
        slot: t.slot, permanent: !!t.permanent, holders: t.holders ?? null, tagline: t.tagline || null,
        peakPage: t.page ? 'https://www.peakbuybot.com' + t.page : null,
        chartUrl: p?.url || t.chartUrl || null,
        pool: p?.pairAddress || null,
        priceUsd: p ? Number(p.priceUsd) : (t.priceUsd ?? null),
        change: p?.priceChange || { h1: t.change1h, h24: t.change24h },
        volume24h: p?.volume?.h24 ?? t.volume24h ?? null,
        liquidity: p?.liquidity?.usd ?? t.liquidity ?? null,
        marketCap: p?.marketCap ?? p?.fdv ?? t.marketCap ?? null,
        txns5m: p?.txns?.m5 || null,
        dex: p ? { priceChange: p.priceChange, volume: p.volume, txns: p.txns } : null,
        pairCreatedAt: p?.pairCreatedAt || null,
      };
    }),
  };
}

async function candles(chain, pool) {
  const url = `${GECKO}/${encodeURIComponent(chain)}/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=1&limit=1000&currency=usd`;
  const j = await cached(`gecko:${chain}:${pool}`, CANDLE_TTL, () => geckoLimited(url));
  const list = j?.data?.attributes?.ohlcv_list || [];
  return list.map(([time, open, high, low, close, value]) => ({ time, open, high, low, close, value })).sort((a, b) => a.time - b.time);
}

// ---- background loop: board every 10s, candles kept under ~90s old, momentum on every pass
let state = null;
const candleKey = t => t.pool ? `gecko:${t.chain}:${t.pool}` : null;
async function refresh() {
  const b = await board();
  const now = Date.now() / 1000;
  for (const t of b.tokens) {
    const key = `${t.chain}:${t.mint}`;
    const lp = livePrices.get(key);
    if (lp && Date.now() - lp.at < 15_000 && lp.price > 0) {
      if (t.priceUsd > 0 && t.marketCap) t.marketCap *= lp.price / t.priceUsd;
      t.priceUsd = lp.price;
    }
    if (t.pool) candles(t.chain, t.pool).catch(() => {});               // queued and rate-limited; result lands in the cache
    tracker.recordHolders(key, t.holders, now);
    const hit = cache.get(candleKey(t) || '');
    const list = hit?.value?.data?.attributes?.ohlcv_list || [];
    const bars = list.map(([time, open, high, low, close, value]) => ({ time, open, high, low, close, value })).sort((a, c) => a.time - c.time);
    const m = Momentum.score({ price: t.priceUsd, bars, dex: t.dex || {}, liquidity: t.liquidity, marketCap: t.marketCap, pairCreatedAt: t.pairCreatedAt }, tracker.history(key), now);
    tracker.recordScore(key, m.score, now);
    t.momentum = { ...m, history: tracker.history(key).scores.slice(-90).map(p => [Math.round(p.t), p.s]) };
    delete t.dex;
  }
  state = b;
  push('board', state);
}

// ---- fast prices: Jupiter for Solana coins every 2.5s, pushed to every open page
const livePrices = new Map();   // chain:mint -> { price, at }
async function fastTick() {
  if (!state) return;
  const sol = state.tokens.filter(t => t.chain === 'solana').map(t => t.mint);
  if (!sol.length) return;
  try {
    const j = await getJson(JUP + sol.join(','));
    const changed = {};
    for (const t of state.tokens) {
      const p = t.chain === 'solana' ? j[t.mint]?.usdPrice : null;
      if (!(p > 0)) continue;
      const key = `${t.chain}:${t.mint}`;
      livePrices.set(key, { price: p, at: Date.now() });
      if (t.priceUsd !== p) {
        if (t.priceUsd > 0 && t.marketCap) t.marketCap *= p / t.priceUsd;
        t.priceUsd = p; changed[key] = p;
      }
    }
    if (Object.keys(changed).length) push('prices', { t: Date.now(), prices: changed });
  } catch (e) { /* keep the last prices; DexScreener still updates them every 10s */ }
}
setInterval(fastTick, 2500);

// ---- server-sent events
const streams = new Set();
function push(event, data) {
  if (!streams.size) return;
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}
setInterval(() => { for (const res of streams) res.write(': keep-alive\n\n'); }, 20_000);
async function loop() {
  try { await refresh(); } catch (e) { console.error('refresh', e.message); }
  setTimeout(loop, 10_000);
}
loop();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, await readFile(path.join(HERE, 'index.html')), 'text/html; charset=utf-8');
    }
    const asset = url.pathname.match(/^\/assets\/([a-z0-9-]+\.png)$/);
    if (asset) return send(res, 200, await readFile(path.join(HERE, 'assets', asset[1])), 'image/png');
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write('retry: 3000\n\n');
      if (state) res.write(`event: board\ndata: ${JSON.stringify(state)}\n\n`);
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (url.pathname === '/health') return send(res, 200, { ok: true, board: !!state });
    if (url.pathname === '/momentum.js') return send(res, 200, await readFile(path.join(HERE, 'momentum.js')), 'text/javascript; charset=utf-8');
    if (url.pathname === '/api/board') { if (!state) await refresh(); return send(res, 200, state); }
    if (url.pathname === '/api/candles') {
      const chain = url.searchParams.get('chain'), pool = url.searchParams.get('pool');
      if (!/^[a-z0-9-]+$/.test(chain || '') || !/^[A-Za-z0-9]+$/.test(pool || '')) return send(res, 400, { error: 'chain and pool are required' });
      return send(res, 200, { candles: await candles(chain, pool) });
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(req.url, err.message);
    send(res, err.status === 429 ? 503 : 502, { error: err.message });
  }
}).listen(PORT, () => console.log(`Peak Ridge on http://localhost:${PORT}`));
