// Peak Ridge broadcaster: opens the page's 1280×720 broadcast frame in a real browser on a virtual screen, then
//   1. streams that screen 24/7 to every RTMP(S) address in STREAM_URLS (Telegram, YouTube, X, Kick, Twitch...)
//   2. keeps one pinned post in a Telegram channel updated with a fresh screenshot and the momentum leaders
//   3. serves /health and /snapshot.jpg (the latest frame) on PORT
// Every part is optional: with no STREAM_URLS it doesn't stream, with no TELEGRAM_* it doesn't post.
//
// Env:
//   PAGE_URL            page to show (default: the Railway site with ?broadcast=1)
//   STREAM_URLS         space/comma separated rtmp(s)://host/app/KEY targets; "file:/path.mp4" records instead (testing)
//   VIDEO_BITRATE       e.g. 3000k (default)          FPS  default 30          RECORD_SECONDS  for file: targets
//   TELEGRAM_BOT_TOKEN  bot that is an admin of the channel
//   TELEGRAM_CHAT_ID    @channelusername or -100… id
//   TELEGRAM_MESSAGE_ID reuse an existing post after a restart (the log prints the id to set)
//   CARD_EVERY_SEC      how often the pinned post refreshes (default 120)
//   WATCH_URL           optional link for a "Watch live" button (e.g. the channel's stream link)
//   EXTRA_CHROME_ARGS   extra browser flags

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import http from 'node:http';

const W = 1280, H = 720;
const FPS = Number(process.env.FPS || 30);
const BITRATE = process.env.VIDEO_BITRATE || '3000k';
const PAGE_URL = process.env.PAGE_URL || 'https://peak-ridge-web-production.up.railway.app/?broadcast=1';
const SITE_URL = new URL('/', PAGE_URL).href;
const BOARD_URL = new URL('/api/board', PAGE_URL).href;
const STREAM_URLS = (process.env.STREAM_URLS || '').split(/[\s,]+/).filter(Boolean);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';
const CARD_EVERY = Math.max(30, Number(process.env.CARD_EVERY_SEC || 120)) * 1000;
const WATCH_URL = process.env.WATCH_URL || '';
const DISPLAY = ':99';
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const status = { startedAt: Date.now(), page: 'starting', stream: STREAM_URLS.length ? 'starting' : 'off', streamRestarts: 0, lastCardAt: null, messageId: Number(process.env.TELEGRAM_MESSAGE_ID) || null, lastError: null };
let lastShot = null;

// ---------- virtual screen ----------
function startXvfb() {
  const x = spawn('Xvfb', [DISPLAY, '-screen', '0', `${W}x${H}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  x.on('exit', code => { log('Xvfb exited', code); process.exit(1); });
  return x;
}

// ---------- browser ----------
let browser, page;
async function openPage() {
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.launch({
    headless: false, chromiumSandbox: false, env: { ...process.env, DISPLAY },
    args: ['--kiosk', `--window-size=${W},${H}`, '--window-position=0,0', '--no-first-run', '--noerrdialogs', '--disable-infobars',
      '--hide-scrollbars', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--disable-features=Translate',
      ...(process.env.EXTRA_CHROME_ARGS || '').split(/\s+/).filter(Boolean)],
  });
  const ctx = await browser.newContext({ viewport: null, ignoreHTTPSErrors: !!process.env.IGNORE_HTTPS_ERRORS });
  page = await ctx.newPage();
  page.on('crash', () => { log('page crashed, reopening'); status.page = 'crashed'; reopen(); });
  page.on('pageerror', e => log('page error:', e.message));
  // fullscreen hides the tab strip and address bar, so the screen shows only the page
  try {
    const cdp = await ctx.newCDPSession(page);
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'fullscreen' } });
  } catch (e) { log('fullscreen failed:', e.message); }
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  status.page = 'ok';
  log('showing', PAGE_URL);
}
let reopening = false;
async function reopen() {
  if (reopening) return; reopening = true;
  for (let i = 0; ; i++) {
    try { await openPage(); break; } catch (e) { status.lastError = 'page: ' + e.message; log('open failed:', e.message); await sleep(Math.min(60_000, 5000 * (i + 1))); }
  }
  reopening = false;
}

// ---------- stream ----------
function ffmpegArgs() {
  const files = STREAM_URLS.filter(u => u.startsWith('file:')).map(u => u.slice(5));
  const rtmp = STREAM_URLS.filter(u => !u.startsWith('file:'));
  const enc = ['-f', 'x11grab', '-draw_mouse', '0', '-video_size', `${W}x${H}`, '-framerate', String(FPS), '-i', `${DISPLAY}.0`,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p',
    '-b:v', BITRATE, '-maxrate', BITRATE, '-bufsize', String(parseInt(BITRATE) * 2) + 'k', '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100'];
  if (process.env.RECORD_SECONDS) enc.push('-t', process.env.RECORD_SECONDS);
  const outs = [...rtmp.map(u => `[f=flv:onfail=ignore]${u}`), ...files.map(f => `[f=mp4:movflags=+faststart]${f}`)];
  return ['-hide_banner', '-loglevel', 'warning', ...enc, '-f', 'tee', outs.join('|')];
}
function startStream() {
  if (!STREAM_URLS.length) return;
  const redact = s => s.replace(/(rtmps?:\/\/[^|\]]+\/)[^|\]\s]+/g, '$1***');
  log('streaming to', STREAM_URLS.map(redact).join(' | '));
  const ff = spawn('ffmpeg', ffmpegArgs(), { stdio: ['ignore', 'inherit', 'pipe'] });
  status.stream = 'live';
  ff.stderr.on('data', d => { const t = redact(String(d)).trim(); if (t) { log('ffmpeg:', t.slice(0, 300)); status.lastError = 'ffmpeg: ' + t.slice(0, 200); } });
  ff.on('exit', code => {
    status.stream = 'restarting'; status.streamRestarts++;
    log('ffmpeg exited', code);
    if (process.env.RECORD_SECONDS) { status.stream = 'recorded'; return; }
    setTimeout(startStream, 5000);
  });
}

// ---------- Telegram ----------
async function tg(method, fields, photo) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) if (v != null) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (photo) fd.append('photo', new Blob([photo], { type: 'image/jpeg' }), 'peak-ridge.jpg');
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({ ok: false, description: 'bad response ' + r.status }));
  if (!j.ok) { const e = new Error(`${method}: ${j.description}`); e.retryAfter = j.parameters?.retry_after; throw e; }
  return j.result;
}
const escHtml = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
async function caption() {
  try {
    const b = await (await fetch(BOARD_URL)).json();
    const scored = b.tokens.filter(t => t.momentum?.score != null).sort((a, c) => c.momentum.score - a.momentum.score).slice(0, 3);
    const top = b.tokens[0];
    const lines = scored.map((t, i) => `${['🥇', '🥈', '🥉'][i]} <b>$${escHtml(t.symbol)}</b>  ${t.momentum.score}/100 · ${escHtml(t.momentum.phaseLabel)} · #${t.rank} on Peak`);
    const time = new Date().toISOString().slice(11, 16) + ' UTC';
    return `🏔 <b>Peak Ridge · live</b>\n\n<b>Top momentum now</b>\n${lines.join('\n')}\n\n#1 on Peak: <b>$${escHtml(top?.symbol)}</b>\nUpdated ${time}`;
  } catch (e) { return '🏔 <b>Peak Ridge · live</b>'; }
}
function buttons() {
  const row = [{ text: '📈 Open the live board', url: SITE_URL }];
  if (WATCH_URL) row.push({ text: '🔴 Watch live', url: WATCH_URL });
  return { inline_keyboard: [row] };
}
async function postCard() {
  if (!page) return;
  const shot = await page.screenshot({ type: 'jpeg', quality: 85 });
  lastShot = shot;
  if (!TG_TOKEN || !TG_CHAT) return;
  const cap = await caption();
  try {
    if (status.messageId) {
      await tg('editMessageMedia', { chat_id: TG_CHAT, message_id: status.messageId, media: { type: 'photo', media: 'attach://photo', caption: cap, parse_mode: 'HTML' }, reply_markup: buttons() }, shot);
    } else {
      const m = await tg('sendPhoto', { chat_id: TG_CHAT, caption: cap, parse_mode: 'HTML', reply_markup: buttons(), disable_notification: true }, shot);
      status.messageId = m.message_id;
      log(`posted card, message id ${m.message_id} (set TELEGRAM_MESSAGE_ID=${m.message_id} to keep using it after restarts)`);
      await tg('pinChatMessage', { chat_id: TG_CHAT, message_id: m.message_id, disable_notification: true }).catch(e => log('pin failed:', e.message));
    }
    status.lastCardAt = Date.now();
  } catch (e) {
    status.lastError = e.message; log('telegram:', e.message);
    if (/message to edit not found|MESSAGE_ID_INVALID/i.test(e.message)) status.messageId = null;
    if (e.retryAfter) await sleep(e.retryAfter * 1000);
  }
}

// ---------- health ----------
http.createServer((req, res) => {
  if (req.url === '/snapshot.jpg' && lastShot) { res.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' }); return res.end(lastShot); }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: status.page === 'ok', ...status, streamTargets: STREAM_URLS.length, telegram: !!(TG_TOKEN && TG_CHAT), page: PAGE_URL }));
}).listen(Number(process.env.PORT || 8080));

// ---------- run ----------
startXvfb();
await sleep(1500);
await reopen();
await sleep(8000);                       // let the page load data and fonts before going on air
startStream();
setInterval(() => postCard().catch(e => log('card:', e.message)), CARD_EVERY);
setTimeout(() => postCard().catch(e => log('card:', e.message)), 15_000);
setInterval(() => { log('scheduled page reload'); page?.reload().catch(() => reopen()); }, 6 * 3600e3);   // keep memory in check
