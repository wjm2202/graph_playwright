/**
 * `sfpw sweep [--delete] [--targets SObject:Field,…] [--patterns …]`
 *
 * Purges strays left by crashed runs, by naming convention only (`E2E_%`
 * prefix and `%E2E-%` factory tags): it can never touch real data because
 * real data never carries those markers. Order is children-first
 * (Case → Opportunity → Contact → Lead → Account) so FK constraints do not
 * block parents.
 *
 * API-only, so it needs no browser and no Playwright — the REST calls go
 * through the same SalesforceApi the suite uses, over a fetch-backed request
 * context (the only thing Playwright was providing here).
 */
import type { APIRequestContext } from '@playwright/test';
import { SalesforceApi } from '../api/salesforceApi';
import { buildSweepSoql, parseSweepPatterns, parseSweepTargets } from '../data/sweep';
import { loadEnv } from '../utils/env';
import { boolFlag, noExtraPositionals, parseArgs, stringFlag, type Cli } from './args';

export const usage = `usage: sfpw sweep [--delete] [--targets SObject:Field,…] [--patterns p1,p2]

  (no flags)          DRY RUN: lists what would be deleted
  --delete            actually delete them
  --targets           override the children-first object list
  --patterns          override the E2E naming patterns

Needs SF_INSTANCE_URL + SF_ACCESS_TOKEN in .env (sweeping is API-only).`;

export async function run(argv: string[], cli: Cli): Promise<number> {
  const args = parseArgs(argv, { booleans: ['delete'], strings: ['targets', 'patterns'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  noExtraPositionals(args, 0, 'sweep', usage);

  const cfg = loadEnv(cli.env);
  if (!cfg?.accessToken) {
    cli.err('cannot sweep — set SF_INSTANCE_URL and SF_ACCESS_TOKEN in .env (sf org display --json)');
    return 1;
  }

  const api = new SalesforceApi(fetchRequestContext(), cfg.instanceUrl, cfg.accessToken, cfg.apiVersion);
  const targets = parseSweepTargets(stringFlag(args, 'targets'));
  const patterns = parseSweepPatterns(stringFlag(args, 'patterns'));
  const doDelete = boolFlag(args, 'delete');

  let total = 0;
  for (const target of targets) {
    for (const pattern of patterns) {
      // Page until clean (LIMIT per query); dry runs do a single page per pattern.
      for (;;) {
        const rows = await api.query<{ Id: string } & Record<string, string>>(buildSweepSoql(target, pattern));
        if (rows.length === 0) break;
        total += rows.length;
        for (const row of rows) {
          cli.out(`${doDelete ? '🗑 deleting' : '· would delete'} ${target.sobject}/${row.Id}  ${row[target.field] ?? ''}`);
          if (doDelete) await api.delete(target.sobject, row.Id);
        }
        if (!doDelete) break;
      }
    }
  }

  cli.out(
    doDelete
      ? `\n✔ sweep complete — ${total} record(s) deleted`
      : `\n✔ dry run — ${total} record(s) match; run \`sfpw sweep --delete\` to delete them`,
  );
  return 0;
}

/**
 * The two verbs SalesforceApi needs here (get + delete) over Node's global
 * fetch, shaped like Playwright's APIRequestContext so the API class — and
 * everything it has been tested against — is reused unchanged.
 */
function fetchRequestContext(): APIRequestContext {
  const call = async (url: string, method: string, opts?: { headers?: Record<string, string> }) => {
    const res = await fetch(url, { method, ...(opts?.headers ? { headers: opts.headers } : {}) });
    return {
      ok: () => res.ok,
      status: () => res.status,
      text: () => res.text(),
      json: async (): Promise<unknown> => {
        const body: unknown = await res.json();
        return body;
      },
    };
  };
  return {
    get: (url: string, opts?: { headers?: Record<string, string> }) => call(url, 'GET', opts),
    delete: (url: string, opts?: { headers?: Record<string, string> }) => call(url, 'DELETE', opts),
  } as unknown as APIRequestContext;
}
