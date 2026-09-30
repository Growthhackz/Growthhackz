import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 8;
const LOCK_MS = 15 * 60 * 1000;
const PUBLIC_PATHS = new Set(['/login.html', '/style.css', '/api/login']);

const digest = (s) => createHash('sha256').update(String(s)).digest();

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isLoopback = (addr = '') =>
  addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

// Behind a local reverse proxy (tailscale serve, cloudflared) every request
// arrives from loopback; only then are the forwarded headers trusted.
function clientKey(req) {
  const peer = req.socket.remoteAddress;
  const fwd = isLoopback(peer) ? req.headers['x-forwarded-for']?.split(',')[0].trim() : null;
  return fwd || peer || 'unknown';
}

function isHttps(req) {
  if (req.secure) return true;
  return isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-proto'] === 'https';
}

export function createAuth({ password }) {
  const expected = digest(password);
  const sessions = new Map(); // token -> expiresAt
  const fails = new Map(); // clientKey -> { count, until }

  const valid = (token) => {
    const exp = token && sessions.get(token);
    if (!exp) return false;
    if (exp < Date.now()) { sessions.delete(token); return false; }
    return true;
  };

  function cookie(req, token, maxAgeSec) {
    return [
      `sid=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict',
      `Max-Age=${maxAgeSec}`, ...(isHttps(req) ? ['Secure'] : [])
    ].join('; ');
  }

  function install(app) {
    app.post('/api/login', (req, res) => {
      const key = clientKey(req);
      const f = fails.get(key);
      if (f?.until > Date.now()) {
        const mins = Math.ceil((f.until - Date.now()) / 60_000);
        return res.status(429).json({ error: `too many attempts, try again in ${mins} min` });
      }
      const given = digest(req.body?.password ?? '');
      if (!timingSafeEqual(given, expected)) {
        const count = (f?.count ?? 0) + 1;
        fails.set(key, { count, until: count >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
        return res.status(401).json({ error: 'wrong password' });
      }
      fails.delete(key);
      const token = randomBytes(32).toString('base64url');
      sessions.set(token, Date.now() + SESSION_MS);
      res.setHeader('Set-Cookie', cookie(req, token, SESSION_MS / 1000));
      res.json({ ok: true });
    });

    app.post('/api/logout', (req, res) => {
      sessions.delete(parseCookies(req.headers.cookie).sid);
      res.setHeader('Set-Cookie', cookie(req, '', 0));
      res.json({ ok: true });
    });
  }

  function middleware(req, res, next) {
    // State-changing requests must come from this app's own pages.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let host;
        try { host = new URL(origin).host; } catch { host = null; }
        if (host !== req.headers.host) return res.status(403).json({ error: 'cross-site request refused' });
      }
    }
    if (PUBLIC_PATHS.has(req.path)) return next();
    if (valid(parseCookies(req.headers.cookie).sid)) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login required' });
    return res.redirect('/login.html');
  }

  return { install, middleware };
}
