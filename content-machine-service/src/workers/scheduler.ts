import type { ServiceContext } from '../services/context.js';
import { tick } from '../services/engine.js';

/** Advances in-process jobs and delivers callbacks on a fixed interval, never overlapping itself. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

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
    if (this.running) return;
    this.running = true;
    try {
      const r = await tick(this.ctx);
      if (r.processed || r.callbacks.sent || r.callbacks.failed) this.ctx.log.info(r, 'tick');
    } catch (err) {
      this.ctx.log.error({ err: err instanceof Error ? err.message : String(err) }, 'tick failed');
    } finally {
      this.running = false;
    }
  }
}
