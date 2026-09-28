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
