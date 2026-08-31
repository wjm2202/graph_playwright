/**
 * Unique-per-run record naming (founding doc §9.2, tip #11).
 *
 * Every record a test creates carries a prefix that (a) prevents collisions
 * between parallel workers and concurrent CI runs against a shared org, and
 * (b) lets a periodic API sweeper find and purge leftovers:
 *   SELECT Id FROM Account WHERE Name LIKE 'E2E_%'
 */

const RUN_ID =
  process.env.TEST_RUN_ID ??
  `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

let seq = 0;

/** The identifier shared by every record created in this process. */
export function runId(): string {
  return RUN_ID;
}

/**
 * Build a unique, sweepable record name.
 * uniqueName('Acme') → 'E2E_20260830_x1y2z3_Acme_1'
 */
export function uniqueName(base: string, prefix = 'E2E'): string {
  seq += 1;
  return `${prefix}_${RUN_ID}_${sanitize(base)}_${seq}`;
}

/** SOQL LIKE pattern matching everything this run created. */
export function sweepPattern(prefix = 'E2E'): string {
  return `${prefix}_${RUN_ID}_%`;
}

/** Strip characters that complicate SOQL LIKE queries and CSV exports. */
export function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_');
}
