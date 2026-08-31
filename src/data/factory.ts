/**
 * Data factory — realistic values that are collision-proof BY CONSTRUCTION.
 *
 * Best-practice synthesis (Checkly / DataFactory pattern / UltimateQA parallel
 * strategy): faker gives realism but guarantees nothing about uniqueness —
 * its seed does not coordinate across parallel workers. So every identity
 * value this factory emits carries a unique tag composed of the run id, the
 * Playwright worker index, and a per-process sequence: two workers, two CI
 * runs, or two calls can never mint the same Lead twice — which is exactly
 * what Salesforce duplicate rules would otherwise reject.
 *
 * Tag shape: `E2E-<run6>-w<worker>-<seq>` (hyphenated: legal in names and
 * email local parts). The sweeper matches both this ('%E2E-%') and the
 * uniqueName prefix ('E2E_%').
 *
 * Emails end in `@e2e.invalid` — RFC 2606 reserves .invalid, so test emails
 * can never route anywhere real.
 *
 * faker is seeded from (runId, workerIndex): a re-run with TEST_RUN_ID pinned
 * reproduces the same human-readable names (debuggability) while tags keep
 * them unique.
 */

import { faker } from '@faker-js/faker';
import { runId } from '../utils/naming';

let seq = 0;

function workerIndex(): string {
  const w = process.env.TEST_WORKER_INDEX;
  return w ?? '0';
}

/** `E2E-<run6>-w<worker>-<seq>` — unique across calls, workers, and runs. */
export function uniqueTag(): string {
  seq += 1;
  const run6 = runId().split('_').pop() ?? runId();
  return `E2E-${run6}-w${workerIndex()}-${seq}`;
}

let seeded = false;
function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  const key = `${runId()}|${workerIndex()}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  faker.seed(h);
}

type Gen = () => string;

const SPECS: Record<string, Gen> = {
  'person.firstName': () => faker.person.firstName(),
  'person.lastName': () => faker.person.lastName(),
  'person.fullName': () => faker.person.fullName(),
  'person.jobTitle': () => faker.person.jobTitle(),
  company: () => faker.company.name(),
  'company.name': () => faker.company.name(),
  phone: () => faker.phone.number({ style: 'international' }),
  'address.street': () => faker.location.streetAddress(),
  'address.city': () => faker.location.city(),
};

export function fakeSpecs(): string[] {
  return [...Object.keys(SPECS), 'email', 'internet.email'].sort();
}

/**
 * Generate a value for a spec. Identity-bearing kinds (names, company, email,
 * street) get the unique tag appended; phone/city are realism-only (they are
 * not uniqueness-constrained surfaces and cannot carry a tag cleanly).
 */
export function generate(spec: string): string {
  ensureSeeded();
  if (spec === 'email' || spec === 'internet.email') {
    const local = `${faker.person.firstName()}.${faker.person.lastName()}.${uniqueTag()}`
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '');
    return `${local}@e2e.invalid`;
  }
  const gen = SPECS[spec];
  if (!gen) {
    throw new Error(`unknown {fake:${spec}} — supported: ${fakeSpecs().join(', ')}`);
  }
  const value = gen();
  const TAGGED = new Set(['person.firstName', 'person.lastName', 'person.fullName', 'company', 'company.name', 'address.street']);
  return TAGGED.has(spec) ? `${value} ${uniqueTag()}` : value;
}
