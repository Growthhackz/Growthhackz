import { describe, expect, it } from 'vitest';
import { withTimeout } from '../src/lib/timeout.js';

describe('hard time limits', () => {
  it('fails a call that never returns, and passes through one that does', async () => {
    // Seen live: one research lookup never returned and froze every order behind it.
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 50, 'X lookup')).rejects.toThrow('X lookup took longer than 0s');
    await expect(withTimeout(Promise.resolve('ok'), 50, 'quick')).resolves.toBe('ok');
    await expect(withTimeout(Promise.reject(new Error('boom')), 50, 'failing')).rejects.toThrow('boom');
  });
});
