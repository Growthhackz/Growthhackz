import type { ServiceContext } from '../services/context.js';
import { tick } from '../services/engine.js';

/** A tick still running after this long is treated as stuck. */
export const STUCK_AFTER_MS = 15 * 60_000;

/** Advances in-process jobs and delivers callbacks on a fixed interval, never overlapping itself. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private startedAt = 0;
  private runs = 0;

  constructor(private readonly ctx: ServiceContext) {}

  start(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), this.ctx.config.TICK_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async run(): Promise<void> {
    if (this.running) {
      // A tick stuck on a call that never returns would otherwise stop every order: let the next one go ahead.
      if (Date.now() - this.startedAt < STUCK_AFTER_MS) return;
      this.ctx.log.error({ minutes: Math.round((Date.now() - this.startedAt) / 60_000) }, 'tick stuck; starting a new one');
    }
    const id = ++this.runs;
    this.running = true;
    this.startedAt = Date.now();
    try {
      const r = await tick(this.ctx);
      if (r.processed || r.callbacks.sent || r.callbacks.failed) this.ctx.log.info(r, 'tick');
    } catch (err) {
      this.ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, 'tick failed');
    } finally {
      if (id === this.runs) this.running = false;
    }
  }
}
