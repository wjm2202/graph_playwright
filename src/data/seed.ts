/**
 * Declarative data seeding (design doc §3.2 `seed` block).
 *
 * Specs are ordered; each creates one record through the API layer (which
 * tracks Ids for children-first teardown via api.deleteAll()). Field values
 * may embed placeholders:
 *   {unique:Base}     → utils/naming.uniqueName('Base')  (collision-safe, sweepable)
 *   {ref:acct.id}     → a property of an earlier-seeded record (id or any resolved field)
 *   {runId}           → the run identifier
 * Placeholders substitute inline anywhere in a string value, so
 * "Renewal for {ref:acct.id}" works. Journey step `with` args use the same
 * engine via resolvePlaceholders().
 */

import { uniqueName, runId } from '../utils/naming';
import { generate as fakeGenerate } from './factory';

export interface SeedSpec {
  /** Handle other seeds/steps use to reference this record. */
  ref: string;
  sobject: string;
  fields: Record<string, unknown>;
  /**
   * Find-or-create: match on these (resolved) fields first. Found records are
   * NOT tracked for teardown — you only ever delete data you created.
   */
  findBy?: string[];
}

export interface SeededRecord {
  ref: string;
  sobject: string;
  id: string;
  /** Fields as sent to the API (placeholders resolved). */
  fields: Record<string, unknown>;
  /** true = matched an existing record (findBy); teardown must not touch it. */
  found?: boolean;
}

export type RefMap = Record<string, SeededRecord>;

/** The slice of SalesforceApi that seeding needs (mockable in unit tests). */
export interface SeedApi {
  create(sobject: string, fields: Record<string, unknown>): Promise<string>;
  /** Required only when a spec uses findBy. */
  findOne?(sobject: string, where: Record<string, unknown>): Promise<string | null>;
}

const PLACEHOLDER_RE = /\{(unique|ref|runId|fake)(?::([^}]*))?\}/g;

/** Resolve placeholders inside one value (strings only; others pass through). */
export function resolvePlaceholders(value: unknown, refs: RefMap): unknown {
  if (typeof value !== 'string') return value;

  // A string that IS a single {ref:x.y} keeps the referenced value's type.
  const single = /^\{ref:([^}]+)\}$/.exec(value);
  if (single?.[1] !== undefined) return lookupRef(single[1], refs);

  return value.replace(PLACEHOLDER_RE, (_m, kind: string, arg: string | undefined) => {
    switch (kind) {
      case 'unique':
        return uniqueName(arg ?? 'Rec');
      case 'fake':
        return fakeGenerate(arg ?? 'person.fullName');
      case 'runId':
        return runId();
      case 'ref':
        return String(lookupRef(arg ?? '', refs));
      default:
        return _m;
    }
  });
}

function lookupRef(pathExpr: string, refs: RefMap): unknown {
  const [ref = '', ...rest] = pathExpr.split('.');
  const prop = rest.join('.');
  const rec = refs[ref];
  if (!rec) {
    throw new Error(
      `{ref:${pathExpr}}: unknown ref '${ref}' — seeded so far: ${Object.keys(refs).join(', ') || '(none)'} (refs resolve in order; forward references are invalid)`,
    );
  }
  if (!prop || prop === 'id') return rec.id;
  if (prop === 'sobject') return rec.sobject;
  if (prop in rec.fields) return rec.fields[prop];
  throw new Error(
    `{ref:${pathExpr}}: '${prop}' not found on '${ref}' — available: id, sobject, ${Object.keys(rec.fields).join(', ')}`,
  );
}

/** Seed records in order; returns the ref map for steps/assertions. */
export async function seedRecords(api: SeedApi, specs: SeedSpec[]): Promise<RefMap> {
  const refs: RefMap = {};
  for (const spec of specs) {
    if (!spec.ref) throw new Error(`seed spec for ${spec.sobject} is missing a ref`);
    if (refs[spec.ref]) throw new Error(`duplicate seed ref '${spec.ref}'`);
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(spec.fields)) {
      fields[k] = resolvePlaceholders(v, refs);
    }

    if (spec.findBy?.length) {
      if (!api.findOne) {
        throw new Error(
          `seed '${spec.ref}' uses findBy but the api has no findOne — pass a SeedApi with findOne (SalesforceApi provides it)`,
        );
      }
      const where: Record<string, unknown> = {};
      for (const f of spec.findBy) {
        if (!(f in fields)) throw new Error(`seed '${spec.ref}': findBy field '${f}' is not in fields`);
        where[f] = fields[f];
      }
      const existingId = await api.findOne(spec.sobject, where);
      if (existingId) {
        // Found, not created: never tracked, never torn down.
        refs[spec.ref] = { ref: spec.ref, sobject: spec.sobject, id: existingId, fields, found: true };
        continue;
      }
    }

    const id = await api.create(spec.sobject, fields);
    refs[spec.ref] = { ref: spec.ref, sobject: spec.sobject, id, fields, found: false };
  }
  return refs;
}
