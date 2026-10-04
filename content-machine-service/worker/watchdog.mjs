import {readdirSync, readFileSync} from 'node:fs';
import {chromium} from 'playwright';
import {NotPostedError} from './reddit.mjs';

/**
 * Keeps the worker container healthy. Out of processes, threads or memory, nothing works (browsers don't start,
 * sharp can't render), so the worker restarts itself (Railway restarts it) instead of failing every order it touches.
 */
export const EXHAUSTED = /\bE(AGAIN|NOMEM|MFILE|NFILE)\b|Resource temporarily unavailable|pthread_create|Cannot allocate memory|signal=SIGTRAP/;
/** Leftover browser processes nobody reaped; past this the container is about to run out. */
export const MAX_ZOMBIES = 100;

const firstLine = e => String(e?.message || e).split('\n')[0].slice(0, 160);

let restarting = false;
/** Restarts the worker (after a moment, so the failure in hand is reported) when an error says the container ran out. */
export function restartIfExhausted(e, exit = code => process.exit(code), delayMs = 3000) {
  if (restarting || !EXHAUSTED.test(String(e?.message || e))) return false;
  restarting = true;
  console.error(`Worker out of processes/memory (${firstLine(e)}); restarting to recover.`);
  setTimeout(() => exit(1), delayMs).unref?.();
  return true;
}

/** A browser that never started sent nothing: every site handler then fails it as safe to retry, never "uncertain". */
export function guardLaunch(browserType = chromium, onFail = restartIfExhausted) {
  if (browserType.launch.guarded) return;
  const launch = browserType.launch.bind(browserType);
  const guarded = async (...args) => {
    try { return await launch(...args); } catch (e) {
      onFail(e);
      throw new NotPostedError(`could not start the browser (${firstLine(e)}); nothing was sent.`);
    }
  };
  guarded.guarded = true;
  browserType.launch = guarded;
}

/** Processes in the container that exited but were never reaped. */
export function zombies(proc = '/proc') {
  let n = 0;
  try {
    for (const pid of readdirSync(proc)) {
      if (!/^\d+$/.test(pid)) continue;
      try { if (/^\d+ \(.*\) Z /s.test(readFileSync(`${proc}/${pid}/stat`, 'utf8'))) n++; } catch {}
    }
  } catch {}
  return n;
}

/** Checks for a pile of unreaped processes; restarts before the container runs out. */
export function checkZombies(proc = '/proc', exit) {
  const n = zombies(proc);
  if (n > MAX_ZOMBIES) restartIfExhausted(new Error(`${n} unreaped processes (EAGAIN soon)`), exit);
  return n;
}

export const resetWatchdog = () => { restarting = false; };
