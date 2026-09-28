/**
 * WURK diagnostics. Nothing here pays unless you pass --execute to `smoke`.
 *
 *   npm run wurk -- status
 *   npm run wurk -- quote --x @handle --post https://x.com/h/status/1 --tg https://t.me/group
 *   npm run wurk -- smoke --post https://x.com/h/status/1            # quote only
 *   npm run wurk -- smoke --post https://x.com/h/status/1 --execute  # pays the $1 small raid
 */
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { systemClock } from '../lib/clock.js';
import { fromMicros } from '../lib/money.js';
import { createProvider } from '../providers/registry.js';
import type { ServiceContext } from '../services/context.js';
import { quoteOnly, smokeTest } from '../wurk/diagnostics.js';
import { createWurkRuntime } from '../wurk/x402.js';

const quietLog = { info: () => {}, warn: () => {}, error: (o: unknown, m?: string) => console.error(m ?? '', o) };

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  const ctx: ServiceContext = { db, provider: createProvider(config), config, clock: systemClock, log: quietLog, wurk: createWurkRuntime(config) };

  if (cmd === 'status') {
    const missing = ctx.wurk.missingForLive();
    console.log(`Live payments: ${missing.length ? `off (set ${missing.join(', ')})` : 'on'}`);
    if (config.WURK_SOLANA_PRIVATE_KEY) {
      const payer = await ctx.wurk.payer();
      const bal = await payer.usdcBalanceMicros();
      console.log(`Wallet: ${payer.address}\nUSDC: ${bal === null ? 'unreadable (check SOLANA_RPC_URL)' : fromMicros(bal)}`);
    }
  } else if (cmd === 'quote') {
    const [x, post, tg] = [arg(args, '--x'), arg(args, '--post'), arg(args, '--tg')];
    if (!x || !post || !tg) throw new Error('Usage: quote --x <profile or @handle> --post <post URL> --tg <t.me link>');
    const r = await quoteOnly(ctx, { xProfile: x, xPost: post, telegram: tg });
    for (const l of r.lines)
      console.log(`${l.component.padEnd(20)} ${l.quoteUsdc === null ? '   -  ' : l.quoteUsdc.toFixed(2).padStart(6)} USDC  (ceiling ${l.ceilingUsdc.toFixed(2)})  ${l.ok ? 'ok' : `PROBLEM: ${l.problem}`}`);
    console.log(`${'total'.padEnd(20)} ${r.totalUsdc.toFixed(2).padStart(6)} USDC  (package ceiling ${r.packageCeilingUsdc.toFixed(2)})`);
    console.log(r.liveReady ? 'Live payments are enabled.' : `Dry run only: set ${r.missingForLive.join(' and ')} to pay.`);
  } else if (cmd === 'smoke') {
    const post = arg(args, '--post');
    if (!post) throw new Error('Usage: smoke --post <test post URL> [--execute]');
    console.log(JSON.stringify(await smokeTest(ctx, post, args.includes('--execute')), null, 2));
  } else {
    console.log('Commands: status | quote --x .. --post .. --tg .. | smoke --post .. [--execute]');
  }
  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
