/**
 * Sweeper (pure parts) — finds test data strays by naming convention:
 * `E2E_%` (uniqueName prefix) and `%E2E-%` (factory tag, embedded mid-value).
 * The env-gated spec in tests/record/sweep.spec.ts does the org I/O;
 * everything here is deterministic and unit-tested.
 */

export interface SweepTarget {
  sobject: string;
  field: string;
}

export const DEFAULT_TARGETS: SweepTarget[] = [
  { sobject: 'Case', field: 'Subject' },
  { sobject: 'Opportunity', field: 'Name' },
  { sobject: 'Contact', field: 'Name' },
  { sobject: 'Lead', field: 'Name' },
  { sobject: 'Account', field: 'Name' },
];

export const DEFAULT_PATTERNS = ['E2E\\_%', '%E2E-%'];

/** 'Lead:Name,Account:Name' → targets; blank/undefined → children-first defaults. */
export function parseSweepTargets(raw?: string): SweepTarget[] {
  if (!raw?.trim()) return DEFAULT_TARGETS;
  return raw.split(',').map((pair) => {
    const [sobject, field] = pair.split(':').map((s) => s.trim());
    if (!sobject || !field) throw new Error(`SWEEP_TARGETS entry '${pair}' must be SObject:Field`);
    return { sobject, field };
  });
}

export function parseSweepPatterns(raw?: string): string[] {
  if (!raw?.trim()) return DEFAULT_PATTERNS;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function buildSweepSoql(target: SweepTarget, pattern: string, limit = 200): string {
  const safe = pattern.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `SELECT Id, ${target.field} FROM ${target.sobject} WHERE ${target.field} LIKE '${safe}' LIMIT ${limit}`;
}
