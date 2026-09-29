import { run } from '../db/database.js';
import { iso, nowMs, type ServiceContext } from './context.js';
import { rawSetting, setRawSetting } from './settingsService.js';

/**
 * Global pause. While paused, orders are still accepted and stored, but nothing runs: no generation, no
 * publishing, no social boost, no worker jobs, no deadlines, no callbacks. Stored in the DB so it survives deploys.
 */
export function pausedAt(ctx: ServiceContext): number | null {
  const v = Number(rawSetting(ctx, 'paused_at') || 0);
  return v > 0 ? v : null;
}

export const isPaused = (ctx: ServiceContext) => pausedAt(ctx) !== null;

export function pauseStatus(ctx: ServiceContext) {
  const at = pausedAt(ctx);
  return { paused: at !== null, paused_at: at ? iso(at) : null };
}

export function pause(ctx: ServiceContext) {
  if (!isPaused(ctx)) setRawSetting(ctx, 'paused_at', String(nowMs(ctx)));
  return pauseStatus(ctx);
}

/** Resumes and pushes open deadlines back by the paused time, so nothing fails because of the pause. */
export function resume(ctx: ServiceContext) {
  const at = pausedAt(ctx);
  if (at !== null) {
    const shift = Math.max(0, nowMs(ctx) - at);
    run(
      ctx.db,
      "UPDATE jobs SET deadline_at = deadline_at + :shift WHERE deadline_at IS NOT NULL AND status NOT IN ('delivered', 'failed', 'skipped', 'uncertain')",
      { shift },
    );
    setRawSetting(ctx, 'paused_at', '0');
  }
  return pauseStatus(ctx);
}
