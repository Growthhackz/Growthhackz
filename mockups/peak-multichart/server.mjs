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
import { createSources } from './sources.mjs';
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

// Like cached(), but never waits once there is a value: an expired value is returned at once and refreshed behind it.
function swr(key, ttl, load) {
  const hit = cache.get(key);
  if (hit && 'value' in hit) { if (Date.now() - hit.at >= ttl && !hit.pending) cached(key, 0, load).catch(() => {}); return hit.value; }
  cached(key, ttl, load).catch(() => {});
  return undefined;
}

// GeckoTerminal: at most 24 calls a minute (the free tier allows 30 per IP), with a 30s pause after any 429.
// Two lanes: coins on the board ("high") always go before the rest ("low").
const geckoCalls = [];
const lanes = { high: [], low: [] };
let geckoPauseUntil = 0, geckoBusy = false;
function geckoLimited(url, lane = 'high') {
  return new Promise((resolve, reject) => { lanes[lane].push({ url, resolve, reject }); pumpGecko(); });
}
async function pumpGecko() {
  if (geckoBusy) return; geckoBusy = true;
  try {
    while (lanes.high.length || lanes.low.length) {
      const now = Date.now();
      while (geckoCalls.length && now - geckoCalls[0] > 60_000) geckoCalls.shift();
      if (now < geckoPauseUntil) { await new Promise(r => setTimeout(r, geckoPauseUntil - now)); continue; }
      if (geckoCalls.length >= 24) { await new Promise(r => setTimeout(r, 60_000 - (now - geckoCalls[0]) + 50)); continue; }
      const job = (lanes.high.length ? lanes.high : lanes.low).shift();
      geckoCalls.push(Date.now());
      try { job.resolve(await getJson(job.url)); }
      catch (e) { if (e.status === 429) geckoPauseUntil = Date.now() + 30_000; job.reject(e); }
    }
  } finally { geckoBusy = false; }
}

// ---- other platforms' trending lists (sources.mjs) and the data we add to every coin on them
const sources = createSources({ getJson, geckoLimited });
const jupCache = new Map();   // mint -> { at, data }: Jupiter's token record (holders, holder change, organic score)
async function jupInfo(mints) {
  const need = [...new Set(mints)].filter(m => !jupCache.has(m) || Date.now() - jupCache.get(m).at > 30_000);
  for (let i = 0; i < need.length; i += 100) {
    try {
      const j = await getJson('https://lite-api.jup.ag/tokens/v2/search?query=' + need.slice(i, i + 100).join(','));
      for (const t of Array.isArray(j) ? j : []) if (t?.id) jupCache.set(t.id, { at: Date.now(), data: t });
    } catch (e) { /* keep what we had */ }
  }
  return m => jupCache.get(m)?.data || null;
}
// DexScreener market data for any list of coins, 30 addresses per call, cached 15s per batch
async function dexInfo(coins) {
  const out = {}, byChain = {};
  for (const c of coins) (byChain[c.chain] ||= new Set()).add(c.address);
  await Promise.all(Object.entries(byChain).flatMap(([chain, set]) => {
    const list = [...set];
    return Array.from({ length: Math.ceil(list.length / 30) }, (_, i) => list.slice(i * 30, i * 30 + 30)).map(async batch => {
      const pairs = await cached(`dexb:${chain}:${batch.join(',')}`, 15_000, () => getJson(`${DEX}/${chain}/${batch.join(',')}`)).catch(() => []);
      for (const a of batch) {
        const best = (pairs || []).filter(p => sameAddr(chain, p.baseToken?.address || '', a)).sort((x, y) => (y.liquidity?.usd || 0) - (x.liquidity?.usd || 0))[0];
        if (best) out[`${chain}:${a}`] = best;
      }
    });
  }));
  return out;
}
const holderChangeOf = j => j ? { h1: j.stats1h?.holderChange ?? null, h6: j.stats6h?.holderChange ?? null } : null;

async function loadPeak() {
  const j = await getJson(PEAK);
  // every coin on Peak's list: the board shows 10, and coins further down replace any that are bleeding
  const tokens = (Array.isArray(j.tokens) ? j.tokens : []).slice().sort((a, b) => a.rank - b.rank).slice(0, 30);
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
  await Promise.all(peak.tokens.slice(0, 5).map(async t => {
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
        rank: t.rank, peakRank: t.rank, paid: !!(t.slot || t.permanent), chain: t.chain, symbol: t.symbol, name: t.name, mint: t.mint,
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

// Holder counts: Peak's own field never changes, so read GeckoTerminal's (they refresh it about every 15 minutes).
async function holderCount(chain, mint) {
  const j = await cached(`holders:${chain}:${mint}`, 20 * 60_000, () => geckoLimited(`${GECKO}/${encodeURIComponent(chain)}/tokens/${encodeURIComponent(mint)}/info`, 'low'));
  return j?.data?.attributes?.holders?.count ?? null;
}

const candleUrl = (chain, pool) => `${GECKO}/${encodeURIComponent(chain)}/pools/${encodeURIComponent(pool)}/ohlcv/minute?aggregate=1&limit=1000&currency=usd`;
const toBars = j => (j?.data?.attributes?.ohlcv_list || []).map(([time, open, high, low, close, value]) => ({ time, open, high, low, close, value })).sort((a, b) => a.time - b.time);
// keep candles fresh in the background: board coins every ~75s on the fast lane, the rest every 5 min on the slow lane
function refreshCandles(chain, pool, onBoard) {
  return swr(`gecko:${chain}:${pool}`, onBoard ? CANDLE_TTL : 300_000, () => geckoLimited(candleUrl(chain, pool), onBoard ? 'high' : 'low'));
}
// for the page: whatever we have right now, never waiting on the queue
function candles(chain, pool) {
  const j = refreshCandles(chain, pool, true);
  return { candles: toBars(j), pending: j === undefined };
}

// ---- background loop: board every 10s, candles kept under ~90s old, momentum on every pass
let state = null;
const candleKey = t => t.pool ? `gecko:${t.chain}:${t.pool}` : null;
const dropState = new Map();   // chain:mint -> { bleedSince, okSince, dropped }
async function refresh() {
  const b = await board();
  const now = Date.now() / 1000;
  const boardCoins = Object.values(sources.boards).flatMap(x => x.items);
  const jup = await jupInfo([...b.tokens.filter(t => t.chain === 'solana').map(t => t.mint), ...boardCoins.filter(x => x.chain === 'solana').map(x => x.address)]);
  for (const t of b.tokens) {
    const key = `${t.chain}:${t.mint}`;
    const lp = livePrices.get(key);
    if (lp && Date.now() - lp.at < 15_000 && lp.price > 0) {
      if (t.priceUsd > 0 && t.marketCap) t.marketCap *= lp.price / t.priceUsd;
      t.priceUsd = lp.price;
    }
    if (t.pool) refreshCandles(t.chain, t.pool, t.peakRank <= (b.tokens[BOARD_SIZE + 2]?.peakRank ?? 99));   // queued; lands in the cache
    const jt = t.chain === 'solana' ? jup(t.mint) : null;
    if (jt?.holderCount > 0) { t.holders = jt.holderCount; tracker.recordHolders(key, jt.holderCount); }
    else {
      holderCount(t.chain, t.mint).then(n => { if (n > 0) tracker.recordHolders(key, n); }).catch(() => {});
      const hn = cache.get(`holders:${t.chain}:${t.mint}`)?.value?.data?.attributes?.holders?.count;
      if (hn > 0) t.holders = hn;
    }
    const hit = cache.get(candleKey(t) || '');
    const list = hit?.value?.data?.attributes?.ohlcv_list || [];
    const bars = list.map(([time, open, high, low, close, value]) => ({ time, open, high, low, close, value })).sort((a, c) => a.time - c.time);
    const m = Momentum.score({ price: t.priceUsd, bars, dex: t.dex || {}, liquidity: t.liquidity, marketCap: t.marketCap, pairCreatedAt: t.pairCreatedAt, holders: t.holders, holderChange: holderChangeOf(jt) }, tracker.history(key), now);
    t.organic = jt?.organicScore ?? null; t.dexRaw = t.dex;
    tracker.recordScore(key, m.score, now);
    t.momentum = { ...m, history: tracker.history(key).scores.slice(-90).map(p => [Math.round(p.t), p.s]) };
    delete t.dex;

    // bleeding coins leave the board after 30s of bleeding (paid slots stay), and come back after 60s without it
    const d = dropState.get(key) || { bleedSince: null, okSince: null, dropped: false };
    const bleeding = m.phase === 'bleeding' && (m.score ?? 50) < 45;
    if (bleeding) { d.bleedSince ??= now; d.okSince = null; if (!t.paid && now - d.bleedSince >= 30) d.dropped = true; }
    else { d.bleedSince = null; d.okSince ??= now; if (d.dropped && now - d.okSince >= 60) d.dropped = false; }
    dropState.set(key, d);
    t.dropped = d.dropped;
  }
  const shown = b.tokens.filter(t => !t.dropped).slice(0, BOARD_SIZE);
  const dropped = b.tokens.filter(t => t.dropped && t.peakRank <= (shown[shown.length - 1]?.peakRank ?? 99))
    .map(t => ({ symbol: t.symbol, name: t.name, chain: t.chain, mint: t.mint, peakRank: t.peakRank, icon: t.icon, chartUrl: t.chartUrl, score: t.momentum?.score ?? null, reason: 'Bleeding' }));
  updatePick(shown, b.tokens, now);
  const blendOut = await blendBoards(shown, jup, now);
  for (const t of b.tokens) delete t.dexRaw;
  state = { updatedAt: b.updatedAt, serverTime: b.serverTime, tokens: shown, dropped, tracked: b.tokens.length, buy: buyState(shown, b.tokens), ...blendOut };
  push('board', state);
}

// ---- every board's top 10, scored the same way, and the blended top 10 across them all
async function blendBoards(shown, jup, now) {
  const uni = new Map();   // chain:address -> entry
  const add = (chain, address, src, rank, extra = {}) => {
    const key = `${chain}:${address}`;
    const e = uni.get(key) || { key, chain, address, sources: {} };
    e.sources[src] = Math.min(e.sources[src] ?? 99, rank);
    for (const [k, v] of Object.entries(extra)) if (v != null && e[k] == null) e[k] = v;
    uni.set(key, e);
  };
  shown.forEach((t, i) => add(t.chain, t.mint, 'peak', i + 1, { symbol: t.symbol, name: t.name, icon: t.icon, peak: t }));
  for (const bd of Object.values(sources.boards)) for (const it of bd.items) add(it.chain, it.address, bd.id, it.rank, { symbol: it.symbol, name: it.name, icon: it.icon });
  const others = [...uni.values()].filter(e => !e.peak);
  const dex = await dexInfo(others);
  const entries = [];
  for (const e of uni.values()) {
    const jt = e.chain === 'solana' ? jup(e.address) : null;
    if (e.peak) {
      const t = e.peak, d = t.dexRaw || {};
      Object.assign(e, { m: t.momentum, price: t.priceUsd, mcap: t.marketCap, liq: t.liquidity, ch1h: t.change?.h1 ?? null, ch6h: t.change?.h6 ?? null,
        volAccel: d.volume?.m5 != null && d.volume?.h1 > 0 ? (d.volume.m5 / 5) / (d.volume.h1 / 60) : null, chartUrl: t.chartUrl, peakRank: t.peakRank,
        ageMin: t.pairCreatedAt ? (Date.now() - t.pairCreatedAt) / 60000 : null });
      delete e.peak;
    } else {
      const p = dex[e.key];
      if (!p && !jt) continue;
      // off-board coins are scored from DexScreener's figures only, so they don't use up GeckoTerminal's rate limit
      const bars = p?.pairAddress ? toBars(cache.get(`gecko:${e.chain}:${p.pairAddress}`)?.value) : [];
      const price = p ? Number(p.priceUsd) : jt?.usdPrice;
      const holders = jt?.holderCount ?? null;
      if (holders > 0) tracker.recordHolders(e.key, holders, now);
      const m = Momentum.score({ price, bars, dex: p ? { priceChange: p.priceChange, volume: p.volume, txns: p.txns } : {}, liquidity: p?.liquidity?.usd ?? jt?.liquidity, marketCap: p?.marketCap ?? p?.fdv ?? jt?.mcap, pairCreatedAt: p?.pairCreatedAt, holders, holderChange: holderChangeOf(jt) }, tracker.history(e.key), now);
      tracker.recordScore(e.key, m.score, now);
      Object.assign(e, { m: { score: m.score, phase: m.phase, phaseLabel: m.phaseLabel, reasons: m.reasons, risks: m.risks, cells: { price: m.cells.price } },
        symbol: e.symbol || p?.baseToken?.symbol || jt?.symbol, name: e.name || p?.baseToken?.name || jt?.name,
        icon: e.icon || p?.info?.imageUrl || jt?.icon || null, price, mcap: p?.marketCap ?? p?.fdv ?? jt?.mcap ?? null, liq: p?.liquidity?.usd ?? jt?.liquidity ?? null,
        ch1h: p?.priceChange?.h1 ?? jt?.stats1h?.priceChange ?? null, ch6h: p?.priceChange?.h6 ?? jt?.stats6h?.priceChange ?? null,
        volAccel: p?.volume?.m5 != null && p?.volume?.h1 > 0 ? (p.volume.m5 / 5) / (p.volume.h1 / 60) : null, chartUrl: p?.url || null,
        ageMin: p?.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 60000 : null });
    }
    e.holders = jt?.holderCount ?? null;
    e.holderCh1h = jt?.stats1h?.holderChange ?? null;
    e.organic = jt?.organicScore ?? null;
    entries.push(e);
  }
  const ranked = Momentum.blend(entries);
  const top = ranked.slice(0, 10);
  const blendRank = new Map(top.map((e, i) => [e.key, i + 1]));
  const byKey = new Map(entries.map(e => [e.key, e]));
  const item = (chain, address, rank) => {
    const e = byKey.get(`${chain}:${address}`) || {};
    return { rank, key: `${chain}:${address}`, chain, symbol: e.symbol || '?', icon: e.icon || null, ch1h: e.ch1h ?? null, score: e.m?.score ?? null, mcap: e.mcap ?? null, chartUrl: e.chartUrl || null, blendRank: blendRank.get(`${chain}:${address}`) || null };
  };
  const boards = [
    { id: 'peak', name: 'Peak', label: 'Trending', link: 'https://t.me/PeakTrending', status: 'live', updatedAt: Date.now(), items: shown.map((t, i) => item(t.chain, t.mint, i + 1)) },
    ...Object.values(sources.boards).map(bd => ({ id: bd.id, name: bd.name, label: bd.label, link: bd.link, status: bd.status, note: bd.note, updatedAt: bd.updatedAt, items: bd.items.map(it => item(it.chain, it.address, it.rank)) })),
    ...Object.values(sources.blocked).map(bd => ({ id: bd.id, name: bd.name, label: bd.label, link: bd.link, status: bd.status, note: bd.note, updatedAt: bd.updatedAt, items: [] })),
  ];
  const blend = top.map((e, i) => ({ rank: i + 1, key: e.key, chain: e.chain, address: e.address, symbol: e.symbol, name: e.name, icon: e.icon, price: e.price, mcap: e.mcap, liq: e.liq,
    ch1h: e.ch1h, holders: e.holders, holderCh1h: e.holderCh1h, score: e.m?.score ?? null, phase: e.m?.phase, phaseLabel: e.m?.phaseLabel, chartUrl: e.chartUrl,
    sources: e.sources, blend: e.blend, parts: e.parts, why: e.why, flags: e.flags }));
  return { boards, blend, universe: entries.length };
}

// ---- best time to buy: one pick that stays put, and a record of how past picks did an hour later
let pick = null;        // { key, symbol, chain, mint, icon, chartUrl, since, entry, p, stop, target }
const pickLog = [];     // { key, symbol, entry, at, p, exit, result }
const keyOf = t => `${t.chain}:${t.mint}`;
function updatePick(shown, all, now) {
  const byKey = new Map(all.map(t => [keyOf(t), t]));
  const cands = shown.filter(t => t.momentum?.buy?.eligible).sort((a, c) => c.momentum.buy.p - a.momentum.buy.p);
  const cur = pick && byKey.get(pick.key), curB = cur?.momentum?.buy;
  let keep = false;
  if (cur && curB && shown.includes(cur)) {
    const held = now - pick.since, best = cands[0];
    keep = cur.priceUsd > pick.stop && curB.p >= 0.48 && curB.passes >= 4;
    // a pick holds for 15 min unless something is far better; after that, a clearly better setup replaces it
    if (keep && best && best !== cur && best.momentum.buy.p >= curB.p + (held < 900 ? 0.08 : 0.03)) keep = false;
  }
  if (!keep && pick) { pick.endedAt = now; pick = null; }
  if (!pick && cands[0]) {
    const t = cands[0], bb = t.momentum.buy;
    pick = { key: keyOf(t), symbol: t.symbol, chain: t.chain, mint: t.mint, since: now, entry: t.priceUsd, p: bb.p, stop: bb.stop, target: bb.target };
    pickLog.push({ key: pick.key, symbol: t.symbol, entry: t.priceUsd, at: now, p: bb.p, result: null });
    if (pickLog.length > 60) pickLog.shift();
  }
  for (const l of pickLog) {
    if (l.result != null || now - l.at < 3600) continue;
    const t = byKey.get(l.key);
    if (t?.priceUsd > 0) { l.exit = t.priceUsd; l.result = t.priceUsd > l.entry ? 'win' : 'loss'; }
    else if (now - l.at > 7200) l.result = 'unknown';
  }
}
function buyState(shown, all) {
  const done = pickLog.filter(l => l.result === 'win' || l.result === 'loss');
  const record = { done: done.length, wins: done.filter(l => l.result === 'win').length, open: pickLog.filter(l => l.result == null).length,
    recent: done.slice(-8).map(l => ({ symbol: l.symbol, ret: l.exit / l.entry - 1, win: l.result === 'win' })) };
  if (pick) {
    const t = all.find(x => keyOf(x) === pick.key);
    return { pick: { ...pick, price: t?.priceUsd ?? null, setup: t?.momentum?.buy ?? null, pnl: t?.priceUsd ? t.priceUsd / pick.entry - 1 : null }, record };
  }
  // no pick: the closest candidate and what it is waiting for
  const near = shown.filter(t => t.momentum?.buy).sort((a, c) => (c.momentum.buy.passes - a.momentum.buy.passes) || (c.momentum.buy.p - a.momentum.buy.p))[0];
  return { pick: null, closest: near ? { key: keyOf(near), symbol: near.symbol, passes: near.momentum.buy.passes, waiting: near.momentum.buy.stages.filter(x => !x.pass).map(x => x.label) } : null, record };
}

// ---- fast prices: Jupiter for Solana coins every 2.5s, pushed to every open page
const livePrices = new Map();   // chain:mint -> { price, at }
async function fastTick() {
  if (!state) return;
  const sol = state.tokens.filter(t => t.chain === 'solana').map(t => t.mint);   // only the 10 on screen need ticks
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
    if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/trending') {
      // index.html is a page fragment (it is also published as an artifact); give browsers a doctype and a mobile viewport
      const html = String(await readFile(path.join(HERE, 'index.html')));
      const head = /^\s*<!doctype/i.test(html) ? '' : '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n<meta name="theme-color" content="#000000">\n';
      return send(res, 200, head + html, 'text/html; charset=utf-8');
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
      return send(res, 200, candles(chain, pool));
    }
    send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(req.url, err.message);
    send(res, err.status === 429 ? 503 : 502, { error: err.message });
  }
}).listen(PORT, () => console.log(`Peak Ridge on http://localhost:${PORT}`));
