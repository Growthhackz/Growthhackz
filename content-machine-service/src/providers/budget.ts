import { run } from '../db/database.js';
import { BudgetError } from '../lib/errors.js';
import type { ServiceContext } from '../services/context.js';

/** Internal planning allowance, not provider billing: text reserves 5, each image 12. */
export const COST_CENTS = { text: 5, image: 12 } as const;

export function reserve(ctx: ServiceContext, orderId: string, cents: number): void {
  const r = run(
    ctx.db,
    'UPDATE orders SET reserved_cents = reserved_cents + :c WHERE id = :id AND reserved_cents + :c <= budget_cents',
    { id: orderId, c: cents },
  );
  if (!r.changes) throw new BudgetError('Generation allowance reached. No additional provider call was made.');
}

/** What a step reserves per provider call (see the reserve() calls in gemini.ts and memes.ts). */
export function reservedFor(kind: string): number {
  if (kind === 'copy' || kind === 'meme_plan') return COST_CENTS.text;
  if (kind === 'campaign_image' || /^sticker_art_\d$/.test(kind) || /^meme_\d$/.test(kind)) return COST_CENTS.image;
  return 0;
}

/** Gives back a reservation for a call that never reached the provider (network failure: nothing was generated). */
export function release(ctx: ServiceContext, orderId: string, cents: number): void {
  if (cents > 0) run(ctx.db, 'UPDATE orders SET reserved_cents = MAX(0, reserved_cents - :c) WHERE id = :id', { id: orderId, c: cents });
}
