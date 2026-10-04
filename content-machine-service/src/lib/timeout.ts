import { UpstreamError } from './errors.js';

/** Settles with `p`, or rejects once `ms` pass: a call that never returns can't hold up the rest of the queue. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}
