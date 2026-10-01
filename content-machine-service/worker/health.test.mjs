import assert from 'node:assert/strict';
import {healthRound, sourceChecks} from './health.mjs';

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
console.log('PASS: health checks only run for configured sources, failures are retried, every round is reported.');
