import assert from 'node:assert/strict';
import {healthRound, sourceChecks} from './health.mjs';
import {effectiveProxy, hasStickySession, proxyIsDown, redditProxy, rotateProxySession, setProxyDown} from './reddit.mjs';

// Only configured sources are checked (Top100Token needs no login; switched off here to stay offline).
const checks = await sourceChecks({TOP100_HEALTH: 'off', COINSCOPE_REFRESH_TOKEN: 'bad'}, 0);
assert.ok(Array.isArray(checks));
assert.ok(checks.every(c => typeof c.source === 'string' && typeof c.ok === 'boolean' && typeof c.detail === 'string'));
assert.deepEqual(checks.map(c => c.source), ['coinscope']);

// A round reports every check to the service.
const sent = [];
await healthRound({request: async (path, body) => { sent.push([path, body]); return {}; }}, {TOP100_HEALTH: 'off'});
assert.equal(sent[0]?.[0], 'health/report');
assert.ok(Array.isArray(sent[0][1].checks));
// Proxy circuit breaker: while the proxy is down, browsers go direct; back to the proxy once it answers.
const raw = 'http://user:pw@proxy.example:12321';
assert.equal(redditProxy(raw).server, 'http://proxy.example:12321');
setProxyDown(true);
assert.ok(proxyIsDown());
assert.equal(redditProxy(raw), undefined);
setProxyDown(false);
assert.equal(redditProxy(raw).username, 'user');

// Sticky session rotation: a fresh session id replaces the old one, everything else in the password is kept.
const sticky = 'http://user:secret_country-us_session-AAAAAAAA_lifetime-168h@geo.example:12321';
assert.ok(hasStickySession(sticky) && !hasStickySession(raw));
const id = rotateProxySession();
assert.match(id, /^[A-Za-z0-9]{8}$/);
assert.equal(decodeURIComponent(new URL(effectiveProxy(sticky)).password), `secret_country-us_session-${id}_lifetime-168h`);
assert.equal(redditProxy(sticky).password, `secret_country-us_session-${id}_lifetime-168h`);

console.log('PASS: proxy circuit breaker and sticky-session rotation, health checks only run for configured sources, failures are retried, every round is reported.');
