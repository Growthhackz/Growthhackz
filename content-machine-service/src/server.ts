import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { Scheduler } from './workers/scheduler.js';

async function main(): Promise<void> {
  const config = loadConfig();
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
  app.log.info({ workers: config.WORKERS_ENABLED, publicHub: config.PUBLIC_HUB_ENABLED }, 'content-machine-service ready');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
