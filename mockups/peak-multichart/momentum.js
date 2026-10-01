/* Peak Momentum: one score (0-100) for how hard a coin is climbing right now and how long it has kept climbing.
 *
 * Shared by the server (live data) and the page (demo mode). Plain script: sets globalThis.PeakMomentum.
 *
 * Five parts, each scaled to -1..+1 and blended:
 *   Price    30%  returns over 1m, 5m, 15m, 30m, 1h, 3h, 6h, each judged against the coin's own volatility
 *                 (a +8% move on a calm coin counts for more than +8% on a wild one) and on raw size
 *   Trend    25%  how cleanly it has gone up over 1h / 3h / 6h: straight-line fit (R²), share of green
 *                 5m candles, higher lows on 15m candles. This is the "keeps going up" signal.
 *   Volume   20%  USD volume per minute over the last 1/5/15/30/60m against its 6h normal rate,
 *                 counted as positive only when price is rising with it (a volume spike on a dump is negative)
 *   Flow     10%  share of buys vs sells over 5m and 1h, and how fast buys are coming in vs the hour's pace
 *   Holders  15%  holder growth over 1h / 6h (holder counts refresh roughly every 15 minutes at the source)
 *
 * Best time to buy: five checks (safe to trade, trend intact, good entry, buyers present, worth the risk). A coin
 * that passes all five gets an estimated chance of being higher an hour later. The estimate is a weighted model,
 * not a measured probability; the server tracks how real picks turn out so the track record can be shown next to it.
 *
 * Parabolic: up 40%+ in the last hour and still steepening (the last 15 minutes climbing faster per minute than
 * the hour as a whole), or up 100%+ in the hour and still up 8%+ in 15 minutes. "Approaching" is the step before.
 * Missing parts drop out and the rest are re-weighted.
 */
(function (root) {
  'use strict';

  const H_PRICE = [1, 5, 15, 30, 60, 180, 360];                 // minutes
  const W_PRICE = { 1: 0.07, 5: 0.17, 15: 0.19, 30: 0.16, 60: 0.16, 180: 0.14, 360: 0.11 };
  const H_VOL = [1, 5, 15, 30, 60];
  const W_VOL = { 1: 0.1, 5: 0.3, 15: 0.25, 30: 0.2, 60: 0.15 };
  const WEIGHTS = { price: 0.30, trend: 0.25, volume: 0.20, flow: 0.10, holders: 0.15 };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const tanh = Math.tanh;
  const pct = v => (v >= 0 ? '+' : '') + (Math.abs(v) >= 100 ? Math.round(v).toLocaleString('en-US') : Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(1)) + '%';
  const mult = v => (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + '×';

  // last close at or before t (bars are minute-start stamped and sorted)
  function closeAt(bars, t) {
    let lo = 0, hi = bars.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].time <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans < 0 ? null : bars[ans].close;
  }
  function bucket(bars, from, spanSec) {
    const out = [];
    for (const b of bars) {
      if (b.time < from) continue;
      const k = Math.floor(b.time / spanSec) * spanSec, last = out[out.length - 1];
      if (last && last.time === k) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.value += b.value || 0; }
      else out.push({ time: k, open: b.open, high: b.high, low: b.low, close: b.close, value: b.value || 0 });
    }
    return out;
  }
  function fit(bars) {   // least squares of ln(close) on time (hours): slope per hour and R²
    const n = bars.length; if (n < 8) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const t0 = bars[0].time;
    for (const b of bars) { const x = (b.time - t0) / 3600, y = Math.log(b.close); sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
    const vx = sxx - sx * sx / n, vy = syy - sy * sy / n, cxy = sxy - sx * sy / n;
    if (vx <= 0) return null;
    const slope = cxy / vx, r2 = vy > 0 ? (cxy * cxy) / (vx * vy) : 0;
    return { slope, r2 };
  }

  /**
   * coin: { price, bars: [{time, open, high, low, close, value}], dex: { priceChange, volume, txns }, liquidity, marketCap,
   *         pairCreatedAt (ms) }
   * hist: { holders: [{t, n}], scores: [{t, s}] }   (from a tracker; optional)
   * now:  seconds
   */
  function score(coin, hist = {}, now = Date.now() / 1000) {
    const bars = (coin.bars || []).filter(b => b && b.close > 0);
    const dex = coin.dex || {};
    const P = coin.price > 0 ? coin.price : bars.length ? bars[bars.length - 1].close : null;
    if (!(P > 0)) return { score: null, phase: 'none', phaseLabel: 'No trades yet', reasons: [], risks: [], confidence: 0, parts: {}, cells: {} };
    const firstT = bars.length ? bars[0].time : now;

    // ---- volatility: stdev of 1m log returns over the last 4h, floored so quiet coins don't explode the maths
    const recent = bars.filter(b => b.time >= now - 240 * 60);
    let s = 0, s2 = 0, n = 0;
    for (let i = 1; i < recent.length; i++) { const r = Math.log(recent[i].close / recent[i - 1].close); if (isFinite(r)) { s += r; s2 += r * r; n++; } }
    const sigma = clamp(n > 5 ? Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2)) : 0.02, 0.004, 0.25);

    // ---- price returns per horizon
    const dexRet = { 5: dex.priceChange?.m5, 60: dex.priceChange?.h1, 360: dex.priceChange?.h6 };
    const ret = {}, retPart = {}, sinceLaunch = {};
    for (const h of H_PRICE) {
      let r = null;
      const since = now - h * 60;
      if (bars.length && firstT <= since + 30) { const c = closeAt(bars, since); if (c) r = Math.log(P / c); }
      else if (dexRet[h] != null) r = Math.log(1 + dexRet[h] / 100);
      else if (bars.length && h >= 60 && firstT > since) { r = Math.log(P / bars[0].open); sinceLaunch[h] = true; }   // younger than the window
      if (r == null || !isFinite(r)) continue;
      ret[h] = r;
      const z = r / (sigma * Math.sqrt(h));
      retPart[h] = 0.6 * tanh(z / 2) + 0.4 * tanh(r / (0.05 * Math.sqrt(h)));
      if (sinceLaunch[h]) retPart[h] *= 0.5;   // a launch pump says less about momentum than a real 3h/6h climb
    }
    let price = null;
    { let a = 0, w = 0; for (const h in retPart) { a += retPart[h] * W_PRICE[h]; w += W_PRICE[h]; } if (w > 0.2) price = a / w; }
    const short = ['1', '5', '15'].reduce((a, h) => a + (retPart[h] ?? 0) * W_PRICE[h], 0) / (W_PRICE[1] + W_PRICE[5] + W_PRICE[15]);
    const long = ['180', '360'].some(h => retPart[h] != null) ? ((retPart[180] ?? retPart[360]) * 0.55 + (retPart[360] ?? retPart[180]) * 0.45) : (retPart[60] ?? 0);

    // ---- trend quality over 1h / 3h / 6h
    const trendW = { 60: 0.3, 180: 0.4, 360: 0.3 }, trendDetail = {};
    let trend = null;
    { let a = 0, w = 0;
      for (const W of [60, 180, 360]) {
        const win = bars.filter(b => b.time >= now - W * 60);
        if (win.length < 10 || (win[win.length - 1].time - win[0].time) < W * 60 * 0.4) continue;
        const f = fit(win); if (!f) continue;
        const b5 = bucket(win, now - W * 60, 300), g = b5.filter(x => x.close >= x.open).length / Math.max(1, b5.length);
        const b15 = bucket(win, now - W * 60, 900);
        let hl = 0, hc = 0; for (let i = 1; i < b15.length; i++) { hc++; if (b15[i].low >= b15[i - 1].low) hl++; }
        const hlr = hc ? hl / hc : 0.5;
        const q = f.r2 * tanh(f.slope / 0.25);
        const v = 0.5 * q + 0.25 * (2 * g - 1) + 0.25 * (2 * hlr - 1);
        trendDetail[W] = { r2: f.r2, slopeHr: f.slope, green: g, higherLows: hlr };
        a += v * trendW[W]; w += trendW[W];
      }
      if (w > 0) trend = a / w;
    }
    // up hours: of the last 6 hourly candles, how many closed green
    const hours = bucket(bars, Math.floor(now / 3600) * 3600 - 5 * 3600, 3600);
    const upHours = hours.filter(x => x.close >= x.open).length;

    // distance from the 1h high
    const hr = bars.filter(b => b.time >= now - 3600);
    const high1h = hr.length ? Math.max(P, ...hr.map(b => b.high)) : P;
    const fromHigh = P / high1h - 1;   // 0 = at the high, -0.2 = 20% below

    // ---- volume against its normal rate
    // Candle history lags a minute or two, so short windows are anchored to the newest candle, and the
    // 5m / 1h / 6h figures come from DexScreener's live counts when we have them.
    const ageMin = Math.max(1, (now - firstT) / 60);
    let baseline = 0;
    if (dex.volume?.h6 > 0) baseline = dex.volume.h6 / Math.min(360, ageMin);
    else if (bars.length) { const span = Math.min(360, Math.max(30, ageMin)); baseline = bars.filter(b => b.time >= now - span * 60).reduce((a, b) => a + (b.value || 0), 0) / span; }
    else if (dex.volume?.h24 > 0) baseline = dex.volume.h24 / Math.min(1440, ageMin);
    const lastT = bars.length ? bars[bars.length - 1].time : now;
    const volRatio = {}, volUsd = {};
    for (const w of H_VOL) {
      let v = null;
      if (w === 5 && dex.volume?.m5 != null) v = dex.volume.m5;
      else if (w === 60 && dex.volume?.h1 != null) v = dex.volume.h1;
      else if (bars.length) v = bars.filter(b => b.time > lastT - w * 60).reduce((a, b) => a + (b.value || 0), 0);
      if (v == null) continue;
      volUsd[w] = v;
      if (baseline > 0) volRatio[w] = (v / Math.min(w, ageMin)) / baseline;
    }
    let volume = null;
    if (Object.keys(volRatio).length) {
      let a = 0, w = 0;
      for (const k in volRatio) { a += tanh(Math.log2(Math.max(volRatio[k], 0.05)) / 1.5) * W_VOL[k]; w += W_VOL[k]; }
      const mag = a / w;                                   // + = busier than normal
      const dir = clamp(((retPart[5] ?? 0) + (retPart[15] ?? 0)) * 1.5, -1, 1);
      volume = mag > 0 ? mag * dir : mag * 0.5;            // rising volume only helps when price rises with it
      if ((volRatio[5] ?? 0) > (volRatio[15] ?? 0) && (volRatio[15] ?? 0) > (volRatio[60] ?? 0) && dir > 0) volume = clamp(volume + 0.15, -1, 1);
    }

    // ---- buy/sell flow
    const share = t => t && (t.buys + t.sells) > 0 ? t.buys / (t.buys + t.sells) : null;
    const b5 = share(dex.txns?.m5), b1h = share(dex.txns?.h1);
    // buy pace: buys in the last 5m against the hour's average 5m
    const buyPace = dex.txns?.m5 && dex.txns?.h1?.buys > 0 ? dex.txns.m5.buys / (dex.txns.h1.buys / 12) : null;
    let flow = null;
    if (b5 != null || b1h != null) {
      flow = 0.6 * tanh(((b5 ?? b1h) - 0.5) * 4) + 0.4 * tanh(((b1h ?? b5) - 0.5) * 4);
      if (buyPace != null) flow = 0.7 * flow + 0.3 * tanh(Math.log2(Math.max(buyPace, 0.1)) / 1.5);
    }

    // ---- holder growth from tracked snapshots
    const hs = (hist.holders || []).filter(x => x.n > 0);
    let holders = null; const holderDelta = {};
    if (hs.length >= 2) {
      const cur = hs[hs.length - 1];
      for (const w of [60, 360]) {
        const then = [...hs].reverse().find(x => x.t <= cur.t - w * 60) || (cur.t - hs[0].t >= w * 60 * 0.4 ? hs[0] : null);
        if (then && then !== cur) holderDelta[w] = { abs: cur.n - then.n, pct: (cur.n - then.n) / Math.max(then.n, 50) * 100, mins: Math.round((cur.t - then.t) / 60) };
      }
      const g60 = holderDelta[60]?.pct, g360 = holderDelta[360]?.pct ?? g60;
      if (g60 != null) holders = 0.6 * tanh(g60 / 5) + 0.4 * tanh(g360 / 15);
    }

    // ---- blend
    const parts = { price, trend, volume, flow, holders };
    let a = 0, w = 0;
    for (const k in parts) if (parts[k] != null && isFinite(parts[k])) { a += parts[k] * WEIGHTS[k]; w += WEIGHTS[k]; }
    const raw = w > 0 ? a / w : 0;
    const sc = Math.round(clamp(50 + 50 * tanh(raw * 1.6), 0, 100));

    // ---- confidence: enough history, real liquidity, real volume
    const liq = coin.liquidity ?? 0;
    const conf = clamp(0.35 * Math.min(1, bars.length / 120) + 0.35 * Math.min(1, liq / 40000) + 0.3 * Math.min(1, (volUsd[60] ?? dex.volume?.h1 ?? 0) / 20000), 0, 1);

    // ---- score trend (from tracker)
    const ss = hist.scores || [];
    const scoreAgo = m => { const x = [...ss].reverse().find(p => p.t <= now - m * 60); return x ? sc - x.s : null; };
    const dScore5 = scoreAgo(5), dScore15 = scoreAgo(15);

    // ---- parabolic: a big hourly gain that is still steepening
    const r60 = ret[60] != null ? Math.exp(ret[60]) - 1 : null;
    const r15 = ret[15] != null ? Math.exp(ret[15]) - 1 : null, r5 = ret[5] != null ? Math.exp(ret[5]) - 1 : null;
    // 15m pace vs the hour's pace (5m pace when there is no 15m figure yet)
    const accel = ret[60] > 0 && ret[15] != null ? (ret[15] / 15) / (ret[60] / 60) : ret[60] > 0 && ret[5] != null ? (ret[5] / 5) / (ret[60] / 60) : null;
    let ema = null;
    for (const b of bars.filter(x => x.time >= now - 90 * 60)) ema = ema == null ? b.close : ema + (b.close - ema) * (2 / 21);
    const stretch = ema ? P / ema - 1 : null;                                                  // above its 20-minute average
    const b3h = bars.filter(b => b.time >= now - 180 * 60);
    const lowBar = b3h.reduce((m, b) => (!m || b.low < m.low ? b : m), null);
    const fromLow = lowBar ? P / lowBar.low - 1 : null, minsSinceLow = lowBar ? Math.round((now - lowBar.time) / 60) : null;
    let paraState = null;
    const rs = r15 ?? r5;   // the recent leg
    const volOk = (volRatio[5] ?? 1) >= 0.6;   // a vertical move on dying volume is not a real parabola
    if (r60 != null && rs != null && volOk && ((r60 >= 0.4 && rs > 0 && (accel ?? 0) >= 1.15 && (r5 ?? 0) >= -0.02) || (r60 >= 1 && rs >= 0.08))) paraState = 'parabolic';
    else if (r60 != null && rs != null && r60 >= 0.15 && rs > 0.04 && ((accel ?? 0) >= 1.3 || rs >= 0.15)) paraState = 'approaching';
    const sample = (mins, step) => { const out = []; for (let t = now - mins * 60; t <= now; t += step * 60) { const c = closeAt(bars, t); out.push(c ?? null); } out[out.length - 1] = P; return out; };
    const parabolic = { state: paraState, r5, r15, r60, accel, stretch, fromLow, minsSinceLow, curve: bars.length ? sample(120, 2) : [] };
    const spark = bars.length ? sample(360, 5) : [];

    // ---- phase: what kind of move this is
    const v5 = volRatio[5] ?? 1;
    let phase = 'chop';
    if (paraState === 'parabolic') phase = 'parabolic';
    else if (short > 0.35 && v5 >= 2 && long < 0.2) phase = 'ignition';
    else if (short > 0.3 && fromHigh > -0.05 && v5 >= 1.3) phase = 'breakout';
    else if (short > 0.25 && long > 0.2 && fromHigh > -0.3) phase = 'climbing';
    else if ((trend ?? 0) > 0.3 && long > 0.15 && Math.abs(short) <= 0.35) phase = 'steady';
    else if ((trend ?? 0) > 0.2 && long > 0.1 && short < -0.15 && fromHigh > -0.3 && (b5 ?? 0.5) >= 0.45) phase = 'dip';
    else if (long > 0.15 && short < -0.25) phase = 'cooling';
    else if (long < -0.2 && short > 0.25) phase = 'reversal';
    else if (long < -0.15 && short <= 0.05) phase = 'bleeding';
    const PHASES = {
      parabolic: 'Parabolic', ignition: 'Ignition', climbing: 'Climbing', breakout: 'Breakout', steady: 'Steady climber', dip: 'Dip in uptrend',
      cooling: 'Cooling off', reversal: 'Reversal try', bleeding: 'Bleeding', chop: 'Choppy',
    };

    // ---- reasons: the strongest evidence, in trader words
    const cand = [];
    const rp = h => ret[h] != null ? (Math.exp(ret[h]) - 1) * 100 : null;
    for (const h of [5, 15, 60, 180]) { const v = rp(h); if (v != null && Math.abs(v) >= (h <= 15 ? 5 : 12)) cand.push({ w: Math.abs(retPart[h]) * W_PRICE[h] * 3, t: `${pct(v)} ${sinceLaunch[h] ? 'since launch' : 'in ' + (h < 60 ? h + 'm' : h / 60 + 'h')}`, good: v > 0 }); }
    if (volUsd[5] === 0) cand.push({ w: 0.9, t: 'No trades in 5m', good: false });
    else if (volRatio[5] != null && (volRatio[5] >= 1.8 || volRatio[5] <= 0.4)) cand.push({ w: Math.abs(Math.log2(volRatio[5])) * 0.25, t: `5m volume ${mult(volRatio[5])} normal`, good: volRatio[5] >= 1 && short > 0 });
    if (hours.length >= 3 && (upHours >= hours.length - 1 || upHours <= 1)) cand.push({ w: 0.5, t: `Up ${upHours} of last ${hours.length} hours`, good: upHours >= hours.length - 1 });
    const td = trendDetail[180] || trendDetail[360] || trendDetail[60];
    if (td && td.r2 >= 0.6 && td.slopeHr > 0) cand.push({ w: td.r2 * 0.6, t: `Clean uptrend (R² ${td.r2.toFixed(2)})`, good: true });
    const hd = holderDelta[60] || holderDelta[360];
    if (hd && Math.abs(hd.abs) >= 10) cand.push({ w: Math.abs(tanh(hd.pct / 5)) * 0.6, t: `${hd.abs > 0 ? '+' : ''}${hd.abs.toLocaleString('en-US')} holders in ${hd.mins >= 90 ? Math.round(hd.mins / 60) + 'h' : hd.mins + 'm'}`, good: hd.abs > 0 });
    if (buyPace != null && (buyPace >= 1.8 || buyPace <= 0.4)) cand.push({ w: Math.abs(Math.log2(buyPace)) * 0.22, t: `Buys ${mult(buyPace)} normal pace`, good: buyPace >= 1 });
    if (b5 != null && (b5 >= 0.62 || b5 <= 0.4)) cand.push({ w: Math.abs(b5 - 0.5) * 1.5, t: `${Math.round(b5 * 100)}% buys (5m)`, good: b5 >= 0.5 });
    if (fromHigh > -0.03 && short > 0.1) cand.push({ w: 0.35, t: 'At the 1h high', good: true });
    else if (fromHigh < -0.3) cand.push({ w: 0.35, t: `${pct(fromHigh * 100)} from 1h high`, good: false });
    const reasons = cand.sort((x, y) => y.w - x.w).slice(0, 3).map(x => ({ text: x.t, good: x.good }));

    // ---- risks
    const risks = [];
    if (liq > 0 && liq < 15000) risks.push('Thin liquidity');
    if (r60 != null && r60 > 1) risks.push('Extended: +' + Math.round(r60 * 100) + '% in 1h');
    if (b5 != null && b5 < 0.4) risks.push('Sell pressure');
    if (short > 0.2 && (volRatio[5] ?? 1) < 0.5) risks.push('Rising on fading volume');
    if (coin.pairCreatedAt && now * 1000 - coin.pairCreatedAt < 3600e3) risks.push('Pair under 1h old');
    if (conf < 0.35) risks.push('Low data');

    // ---- matrix cells for the UI
    const cells = {
      price: Object.fromEntries(H_PRICE.map(h => [h, ret[h] != null ? { pct: rp(h), s: retPart[h], launch: !!sinceLaunch[h] } : null])),
      volume: Object.fromEntries(H_VOL.map(w => [w, volRatio[w] != null ? { x: volRatio[w], usd: volUsd[w] } : null])),
      holders: Object.fromEntries([60, 360].map(w => [w, holderDelta[w] || null])),
      holdersNow: hs.length ? hs[hs.length - 1].n : null,
      buys5: b5, buys1h: b1h, buyPace,
    };
    // ---- best time to buy: five checks, then an estimated chance of being higher in an hour
    const buy = (() => {
      const ageMin = bars.length ? (now - bars[0].time) / 60 : (coin.pairCreatedAt ? (now * 1000 - coin.pairCreatedAt) / 60000 : 0);
      const r180 = ret[180] != null ? Math.exp(ret[180]) - 1 : null;
      const low30 = bars.filter(b => b.time >= now - 30 * 60).reduce((m, b) => Math.min(m, b.low), Infinity);
      let stop = isFinite(low30) && low30 < P * 0.98 ? low30 : P * (1 - Math.max(0.03, 2 * sigma * Math.sqrt(30)));
      stop = Math.max(stop, P * 0.75);
      const riskPct = (P - stop) / P;
      let target = high1h > P * 1.04 ? high1h : P * (1 + 1.6 * riskPct);
      const rr = (target - P) / Math.max(P - stop, P * 1e-6);
      const v5x = volRatio[5] ?? null;
      const st = [];
      const safe = liq >= 20000 && ageMin >= 60 && conf >= 0.5;
      st.push({ key: 'safe', label: 'Safe to trade', pass: safe, detail: liq < 20000 ? 'Liquidity under $20K' : ageMin < 60 ? 'Under 1h old' : conf < 0.5 ? 'Not enough data' : `LP ${Math.round(liq / 1000)}K` });
      const trendS = clamp(((trend ?? long) + long) / 1.2, -1, 1);
      const trendOk = trendS >= 0.12 && (r60 ?? 0) > -0.1 && (r180 ?? r60 ?? 0) >= 0;
      st.push({ key: 'trend', label: 'Trend intact', pass: trendOk, detail: trendOk ? 'Up on 1–6h' : 'No uptrend' });
      const stretchOk = stretch == null || stretch <= 0.12;
      const isDip = stretch != null && stretch < 0 && stretch > -0.15 && fromHigh > -0.3;
      const isBreak = fromHigh > -0.05 && (v5x ?? 0) >= 1.3 && stretchOk;
      const timingOk = stretchOk && fromHigh > -0.35 && (isDip || isBreak || (stretch ?? 0) <= 0.05);
      st.push({ key: 'entry', label: 'Good entry', pass: timingOk, detail: !stretchOk ? `Stretched +${Math.round(stretch * 100)}%` : isDip ? 'Dip in uptrend' : isBreak ? 'Breakout on volume' : timingOk ? 'Near its average' : 'Broken down' });
      const flowOk = (b5 ?? 0.5) >= 0.5 && (buyPace ?? 1) >= 0.7 && (v5x ?? 1) >= 0.5;
      const flowWhy = (b5 ?? 0.5) < 0.5 ? `${Math.round(b5 * 100)}% buys` : (buyPace ?? 1) < 0.7 ? `Buying slowed ${mult(buyPace)}` : (v5x ?? 1) < 0.5 ? `Volume fading ${mult(v5x)}` : b5 != null ? `${Math.round(b5 * 100)}% buys` : 'No flow data';
      st.push({ key: 'flow', label: 'Buyers present', pass: flowOk, detail: flowWhy });
      const rrOk = rr >= 1.5 && riskPct <= 0.25;
      st.push({ key: 'risk', label: 'Worth the risk', pass: rrOk, detail: `${rr.toFixed(1)} : 1` });
      const passes = st.filter(x => x.pass).length;
      const timingS = isDip ? 1 : isBreak ? 0.8 : timingOk ? 0.5 : 0;
      const flowS = clamp(((b5 ?? 0.5) - 0.5) * 4 + ((buyPace ?? 1) - 1) * 0.3, -1, 1);
      const holdS = holderDelta[60] ? tanh(holderDelta[60].pct / 5) : 0;
      let p = 0.45 + 0.08 * trendS + 0.06 * timingS + 0.05 * flowS + 0.03 * tanh((rr - 1.5) / 1.5) + 0.02 * holdS;
      if (sigma > 0.05) p -= 0.03;
      p = clamp(p, 0.3, 0.72);
      return { eligible: passes === 5 && p >= 0.51, p, passes, stages: st, entry: P, stop, target, rr, riskPct, upPct: target / P - 1 };
    })();

    return {
      buy,
      score: sc, raw, phase, phaseLabel: PHASES[phase], reasons, risks, confidence: conf, short, long,
      parts, cells, dScore5, dScore15, upHours, hoursSeen: hours.length, fromHigh, sigma, parabolic, spark,
    };
  }

  // Keeps holder counts and scores over time, per coin, so growth and score direction can be measured.
  function createTracker(maxAgeSec = 7 * 3600) {
    const data = new Map();
    const get = k => { let d = data.get(k); if (!d) { d = { holders: [], scores: [] }; data.set(k, d); } return d; };
    const trim = (arr, now) => { while (arr.length && arr[0].t < now - maxAgeSec) arr.shift(); };
    return {
      history: k => get(k),
      recordHolders(k, n, now = Date.now() / 1000) {
        if (!(n > 0)) return; const d = get(k), last = d.holders[d.holders.length - 1];
        if (!last || last.n !== n || now - last.t > 300) d.holders.push({ t: now, n });
        trim(d.holders, now);
      },
      recordScore(k, s, now = Date.now() / 1000) {
        if (s == null) return; const d = get(k), last = d.scores[d.scores.length - 1];
        if (!last || now - last.t >= 15) d.scores.push({ t: now, s });
        trim(d.scores, now);
      },
      forget(k) { data.delete(k); },
    };
  }

  root.PeakMomentum = { score, createTracker, WEIGHTS, H_PRICE, H_VOL };
})(typeof globalThis !== 'undefined' ? globalThis : this);
