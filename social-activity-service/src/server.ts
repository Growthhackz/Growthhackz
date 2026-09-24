import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Scheduler } from './workers/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
  if (config.PROVIDER !== 'mock' && !config.SERVICE_API_TOKEN) {
    // Anyone who can reach the server could spend the provider balance.
    throw new Error(`SERVICE_API_TOKEN must be set (16+ chars) when PROVIDER=${config.PROVIDER}`);
  }
  const { app, ctx } = buildApp({ config });
  const scheduler = new Scheduler(ctx);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    scheduler.stop();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
  if (config.WORKERS_ENABLED) scheduler.start();
  app.log.info({ provider: ctx.provider.name, workers: config.WORKERS_ENABLED }, 'social-activity-service ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
