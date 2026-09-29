import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../lib/errors.js';
import type { ServiceContext } from '../services/context.js';
import { receiveTrigger } from '../services/engine.js';

const TriggerBody = z
  .object({
    contractAddress: z.string().optional(),
    contract_address: z.string().optional(),
    ca: z.string().optional(),
    mint: z.string().optional(),
    /** Optional upstream id; a repeat with the same id returns the original trigger instead of buying twice. */
    eventId: z.string().max(200).optional(),
    event_id: z.string().max(200).optional(),
  })
  .passthrough();

export function registerTriggerRoutes(app: FastifyInstance, ctx: ServiceContext): void {
  app.post('/v1/trigger', async (req, reply) => {
    const parsed = TriggerBody.safeParse(req.body ?? {});
    if (!parsed.success) throw new ValidationError('Invalid body', parsed.error.flatten().fieldErrors);
    const b = parsed.data;
    const mint = b.contractAddress ?? b.contract_address ?? b.ca ?? b.mint;
    if (!mint) throw new ValidationError('contractAddress is required');
    const headerKey = req.headers['idempotency-key'];
    const r = receiveTrigger(ctx, {
      mint,
      eventId: b.eventId ?? b.event_id ?? (typeof headerKey === 'string' ? headerKey : null),
      source: 'api',
    });
    return reply.code(r.duplicate ? 200 : 202).send({
      triggerId: r.trigger.id,
      contractAddress: r.trigger.mint,
      status: r.trigger.status,
      duplicate: r.duplicate,
      funding: r.trigger.funding_status,
      scheduledBuys: r.positions,
      note: r.trigger.note,
    });
  });
}
