/**
 * Provider setup helper. Read-only against the provider: it never places orders.
 *
 *   npm run setup:provider                         # balance, catalog sync, ranked services per package item
 *   npm run setup:provider -- --apply              # also map each item to its top pick (local DB only)
 *   npm run setup:provider -- --preview req.json   # also preview the starter package for the targets in req.json
 */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/database.js';
import { providerCalls } from '../db/repositories.js';
import { PackageRequestSchema } from '../domain/schemas.js';
import { systemClock } from '../lib/clock.js';
import { createProvider } from '../providers/registry.js';
import { getBalanceSummary } from '../services/balanceService.js';
import { syncCatalog } from '../services/catalogService.js';
import type { ServiceContext } from '../services/context.js';
import { planPackage } from '../services/packageService.js';
import { applyRecommendations, recommendForPackage } from '../services/recommendService.js';

const quietLog = { info: () => {}, warn: () => {}, error: (o: unknown, m?: string) => console.error(m ?? '', o) };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const overwrite = args.includes('--overwrite');
  const previewIdx = args.indexOf('--preview');
  const previewFile = previewIdx >= 0 ? args[previewIdx + 1] : undefined;
  const pkgIdx = args.indexOf('--package');
  const pkg = pkgIdx >= 0 ? args[pkgIdx + 1]! : 'starter';

  const config = loadConfig();
  const db = openDatabase(config.DATABASE_PATH);
  const provider = createProvider(config, (rec) => providerCalls.add(db, rec, new Date().toISOString()));
  const ctx: ServiceContext = { db, provider, config, clock: systemClock, log: quietLog };

  console.log(`Provider: ${provider.name}\n`);

  const balance = await getBalanceSummary(ctx);
  console.log(`Balance: $${balance.balanceUsd.toFixed(4)} ${balance.currency}${balance.lowBalance ? '  (LOW)' : ''}\n`);

  const sync = await syncCatalog(ctx);
  console.log(`Catalog: ${sync.count} services synced\n`);

  for (const rec of recommendForPackage(ctx, pkg, 5)) {
    const label = `${rec.item} (${rec.geo}${rec.premium ? ', premium' : ''})`;
    const tags = [rec.pinnedServiceId && `pinned: ${rec.pinnedServiceId}`, rec.currentServiceId && `mapped: ${rec.currentServiceId}`].filter(Boolean);
    console.log(`== ${label}${tags.length ? `  [${tags.join(', ')}]` : ''}`);
    if (rec.candidates.length === 0) console.log('   no matching services');
    for (const c of rec.candidates) {
      const s = c.service;
      console.log(
        `   ${s.serviceId.padStart(6)}  $${s.ratePer1000Usd.toFixed(4).padStart(9)}/1k  min ${String(s.min).padStart(5)}  max ${String(s.max).padStart(8)}  ` +
          `${s.refill ? 'refill' : '      '} ${s.dripfeed ? 'drip' : '    '}  score ${String(c.score).padStart(3)}  ${s.name}`,
      );
      console.log(`${' '.repeat(10)}${c.reasons.join(', ')}`);
    }
    console.log('');
  }

  if (apply) {
    console.log('Applying top picks to mappings:');
    for (const r of applyRecommendations(ctx, pkg, overwrite)) {
      console.log(`   ${r.item}: ${r.applied ? `→ ${r.serviceId} ${r.serviceName}` : `skipped (${r.reason})`}`);
    }
    console.log('');
  }

  if (previewFile) {
    const req = PackageRequestSchema.parse(JSON.parse(readFileSync(previewFile, 'utf8')));
    const plan = await planPackage(ctx, pkg, req);
    console.log(`Preview of "${pkg}" (nothing is ordered):`);
    for (const l of plan.lines) {
      if (!l.included) {
        console.log(`   ✗ ${l.item}: ${l.skipped}`);
        continue;
      }
      const pace = l.runs && l.runs > 1 ? `${l.runs} runs every ${l.intervalMinutes} min` : 'single delivery';
      console.log(`   ✓ ${l.item}: ${l.quantity} via ${l.serviceId} (${pace}) ≈ $${l.estimatedCostUsd?.toFixed(4)}`);
      for (const n of l.notes) console.log(`       - ${n}`);
    }
    console.log(`   Estimated total: $${plan.estimatedTotalUsd.toFixed(4)}`);
  }

  db.close();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
