/**
 * Money is stored as integer micro-dollars (1 USD = 1_000_000) so that
 * per-1000 panel rates like 0.0123 don't accumulate float error.
 */
export const MICROS_PER_UNIT = 1_000_000;

export function toMicros(value: string | number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(value);
  if (!Number.isFinite(n)) throw new Error(`Not a money amount: ${String(value)}`);
  return Math.round(n * MICROS_PER_UNIT);
}

export function fromMicros(micros: number): number {
  return micros / MICROS_PER_UNIT;
}

/** Cost of `units` at a rate quoted per 1000 units. */
export function costForUnits(ratePer1000Micros: number, units: number): number {
  return Math.ceil((ratePer1000Micros * units) / 1000);
}
