/** One task at a time per key (a site's saved session): health checks and real posts never share a login at once. */
const chains = new Map();
export function withLock(key, fn) {
  const run = (chains.get(key) ?? Promise.resolve()).then(fn, fn);
  chains.set(key, run.catch(() => {}));
  return run;
}
