/**
 * Test-data sweeper — purges strays left by crashed runs, by naming
 * convention only (E2E_% prefix and %E2E-% factory tags): it can never touch
 * real data because real data never carries those markers.
 *
 *   npm run sweep                # DRY RUN: lists what would be deleted
 *   SWEEP_DELETE=1 npm run sweep # actually deletes
 *   SWEEP_TARGETS="Lead:Name,Account:Name"  SWEEP_PATTERNS="E2E\\_%"  # overrides
 *
 * Order is children-first (Case → Opportunity → Contact → Lead → Account) so
 * FK constraints do not block parents. Requires SF_INSTANCE_URL +
 * SF_ACCESS_TOKEN in .env (sweeping is an admin-ish, API-only operation).
 */
import { test } from '@playwright/test';
import { SalesforceApi } from '../../src/api/salesforceApi';
import { loadEnv } from '../../src/utils/env';
import { buildSweepSoql, parseSweepPatterns, parseSweepTargets } from '../../src/data/sweep';

test('sweep E2E test-data strays', async ({ request }) => {
  test.skip(!process.env.SWEEP, 'run via: npm run sweep');
  const cfg = loadEnv();
  if (!cfg?.accessToken) {
     
    console.log('\n⏸  cannot sweep — set SF_INSTANCE_URL and SF_ACCESS_TOKEN in .env (sf org display --json)\n');
    test.skip(true, 'org not configured');
  }
  test.setTimeout(300_000);

  const api = new SalesforceApi(request, cfg!.instanceUrl, cfg!.accessToken!, cfg!.apiVersion);
  const targets = parseSweepTargets(process.env.SWEEP_TARGETS);
  const patterns = parseSweepPatterns(process.env.SWEEP_PATTERNS);
  const doDelete = process.env.SWEEP_DELETE === '1';

  let total = 0;
  for (const target of targets) {
    for (const pattern of patterns) {
      // Page until clean (LIMIT per query); dry runs do a single page per pattern.
      for (;;) {
        const rows = await api.query<{ Id: string } & Record<string, string>>(buildSweepSoql(target, pattern));
        if (rows.length === 0) break;
        total += rows.length;
        for (const row of rows) {
           
          console.log(`${doDelete ? '🗑 deleting' : '· would delete'} ${target.sobject}/${row.Id}  ${row[target.field] ?? ''}`);
          if (doDelete) await api.delete(target.sobject, row.Id);
        }
        if (!doDelete) break;
      }
    }
  }
   
  console.log(
    doDelete
      ? `\n✔ sweep complete — ${total} record(s) deleted`
      : `\n✔ dry run — ${total} record(s) match; run SWEEP_DELETE=1 npm run sweep to delete them`,
  );
});
