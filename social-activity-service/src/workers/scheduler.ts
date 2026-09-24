import { syncCatalog } from '../services/catalogService.js';
import type { ServiceContext } from '../services/context.js';
import { recoverInterruptedSubmissions } from '../services/orderService.js';
import { pollDueOrders } from '../services/pollingService.js';
import { pollOpenRefills, runAutoRefills } from '../services/refillService.js';
import { getBalanceSummary } from '../services/balanceService.js';

interface Job {
  name: string;
  everyMs: number;
  runOnStart: boolean;
  fn: () => Promise<unknown>;
}

/** Runs background jobs on fixed intervals; each job never overlaps with itself. */
export class Scheduler {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(private readonly ctx: ServiceContext) {}

  start(): void {
    recoverInterruptedSubmissions(this.ctx);
    const c = this.ctx.config;
    const jobs: Job[] = [
      { name: 'catalog-sync', everyMs: c.CATALOG_SYNC_INTERVAL_MS, runOnStart: true, fn: () => syncCatalog(this.ctx) },
      { name: 'poll-orders', everyMs: c.POLL_INTERVAL_MS, runOnStart: true, fn: () => pollDueOrders(this.ctx) },
      {
        name: 'refills',
        everyMs: c.REFILL_CHECK_INTERVAL_MS,
        runOnStart: false,
        fn: async () => {
          await runAutoRefills(this.ctx);
          await pollOpenRefills(this.ctx);
        },
      },
      // Logs a warning when the balance drops under LOW_BALANCE_ALERT_USD.
      { name: 'balance-check', everyMs: c.REFILL_CHECK_INTERVAL_MS, runOnStart: true, fn: () => getBalanceSummary(this.ctx) },
    ];
    for (const job of jobs) {
      if (job.runOnStart) void this.runJob(job);
      const t = setInterval(() => void this.runJob(job), job.everyMs);
      t.unref();
      this.timers.push(t);
    }
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  private async runJob(job: Job): Promise<void> {
    if (this.running.has(job.name)) return;
    this.running.add(job.name);
    try {
      await job.fn();
    } catch (err) {
      this.ctx.log.error({ job: job.name, err: err instanceof Error ? err.message : String(err) }, 'background job failed');
    } finally {
      this.running.delete(job.name);
    }
  }
}
