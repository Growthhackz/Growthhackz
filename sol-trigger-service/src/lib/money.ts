export const LAMPORTS_PER_SOL = 1_000_000_000n;

/** "1.5" → 1_500_000_000n, exact (no float rounding). */
export function solToLamports(sol: number | string): bigint {
  const s = typeof sol === 'number' ? sol.toFixed(9) : sol.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid SOL amount: ${sol}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole!) * LAMPORTS_PER_SOL + BigInt((frac + '000000000').slice(0, 9));
}

export function lamportsToSol(l: bigint | number): string {
  const v = BigInt(l);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return (neg ? '-' : '') + (a / LAMPORTS_PER_SOL).toString() + (frac ? '.' + frac : '');
}

/** floor(amount * pct / 100) with pct to 2 decimals, in integer math. */
export function percentOf(amount: bigint, pct: number): bigint {
  const bps = BigInt(Math.round(pct * 100));
  return (amount * bps) / 10_000n;
}
