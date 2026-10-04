import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {NotPostedError} from './reddit.mjs';
import {checkZombies, EXHAUSTED, guardLaunch, MAX_ZOMBIES, resetWatchdog, restartIfExhausted, zombies} from './watchdog.mjs';

// The errors seen when the container ran out of processes (BABYPIMPIN, Oct 3).
assert.ok(EXHAUSTED.test('browserType.launch: Failed to launch: Error: spawn /root/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell EAGAIN'));
assert.ok(EXHAUSTED.test('pthread_create: Resource temporarily unavailable'));
assert.ok(EXHAUSTED.test('browserType.launch: Target page, context or browser has been closed\n  - [pid=34641] <process did exit: exitCode=null, signal=SIGTRAP>'));
assert.ok(!EXHAUSTED.test('Sticker background removal needs review'));

// A browser that could not start is "nothing was sent" (safe to retry), and an exhausted container restarts.
const exits = [];
const fake = {launch: async () => { throw new Error('spawn headless_shell EAGAIN\nCall log: ...'); }};
guardLaunch(fake, e => restartIfExhausted(e, c => exits.push(c), 0));
await assert.rejects(() => fake.launch(), e => e instanceof NotPostedError && /could not start the browser \(spawn headless_shell EAGAIN\); nothing was sent/.test(e.message));
await new Promise(r => setTimeout(r, 10));
assert.deepEqual(exits, [1]);
// Only once, however many lanes hit it.
assert.equal(restartIfExhausted(new Error('EAGAIN'), c => exits.push(c), 0), false);
resetWatchdog();
// Other errors don't restart anything.
assert.equal(restartIfExhausted(new Error('Sticker artwork missing'), c => exits.push(c), 0), false);
const ok = {launch: async () => 'browser'};
guardLaunch(ok); guardLaunch(ok);
assert.equal(await ok.launch(), 'browser');

// Unreaped processes are counted from /proc, and too many restart the worker before spawns fail.
const proc = mkdtempSync(join(tmpdir(), 'proc-'));
const add = (pid, state) => { mkdirSync(join(proc, String(pid))); writeFileSync(join(proc, String(pid), 'stat'), `${pid} (headless shell) ${state} 1 1`); };
add(1, 'S'); add(2, 'Z'); add(3, 'R');
mkdirSync(join(proc, 'self'));
assert.equal(zombies(proc), 1);
for (let i = 0; i < MAX_ZOMBIES; i++) add(100 + i, 'Z');
const zExits = [];
checkZombies(proc, c => zExits.push(c));
await new Promise(r => setTimeout(r, 3100));
assert.deepEqual(zExits, [1]);
console.log('watchdog tests passed');
