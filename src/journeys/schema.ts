/**
 * Journey-as-JSON (design doc §3.2): a journey is DATA — actors, invariants,
 * seed, ordered steps (including first-class deny steps). Clicks/waits live in
 * the TypeScript step catalog, never in JSON — that is the guard against DSL
 * creep. Validation is dependency-free and reports every problem at once.
 */

import type { SeedSpec } from '../data/seed';

export interface ActorStep {
  /** Actor alias (key of journey.actors). */
  actor: string;
  /** Step-catalog entry, e.g. "expense.submit". */
  do: string;
  /** Args for the step; {ref:}/{unique:} placeholders resolve at run time. */
  with?: Record<string, unknown>;
  /** Declarative expectations the step implementation asserts. */
  expect?: Record<string, unknown>;
  timing?: {
    /** Documented handoff: steps are sequential; 'prevStep' is the only value. */
    notBefore?: 'prevStep';
    /** Hard ceiling for this step regardless of baselines. */
    maxDurationMs?: number;
    /** Deliberate choreography delay BEFORE the step (not a flaky-wait). */
    waitMs?: number;
  };
}

export interface DenyStep {
  deny: {
    /** Actor alias that must be REFUSED. */
    actor: string;
    /** Deny-catalog entry, e.g. "expense.approve". */
    capability: string;
    /** Usually a {ref:...} to the record under probe. */
    target?: unknown;
  };
}

export type JourneyStep = ActorStep | DenyStep;

export interface Invariant {
  rule: 'distinctActors';
  actors: string[];
}

export interface Journey {
  journey: string;
  description?: string;
  /** alias → personaId (personas.json). */
  actors: Record<string, string>;
  invariants?: Invariant[];
  seed?: SeedSpec[];
  steps: JourneyStep[];
}

export function isDenyStep(s: JourneyStep): s is DenyStep {
  return typeof (s as DenyStep).deny === 'object' && (s as DenyStep).deny !== null;
}

const ID_RE = /^[a-z][a-z0-9_]*$/;

export interface JourneyValidation {
  ok: boolean;
  errors: string[];
}

/** Static validation. Pass known persona ids to also check actor bindings. */
export function validateJourney(doc: unknown, opts: { personaIds?: string[] | undefined } = {}): JourneyValidation {
  const errors: string[] = [];
  const j = doc as Partial<Journey> | null;
  if (!j || typeof j !== 'object') return { ok: false, errors: ['journey must be an object'] };

  if (!j.journey || !ID_RE.test(j.journey)) errors.push('journey: lower_snake_case id required');

  const aliases = Object.keys(j.actors ?? {});
  if (!j.actors || aliases.length === 0) {
    errors.push('actors: at least one alias → personaId binding required');
  } else {
    for (const [alias, personaId] of Object.entries(j.actors)) {
      if (!ID_RE.test(alias)) errors.push(`actors.${alias}: alias must be lower_snake_case`);
      if (typeof personaId !== 'string' || !personaId) {
        errors.push(`actors.${alias}: personaId must be a non-empty string`);
      } else if (opts.personaIds && !opts.personaIds.includes(personaId)) {
        errors.push(`actors.${alias}: unknown persona '${personaId}' (personas.json has: ${opts.personaIds.join(', ')})`);
      }
    }
  }

  for (const inv of j.invariants ?? []) {
    if (inv.rule !== 'distinctActors') {
      errors.push(`invariants: unknown rule '${String((inv as { rule: unknown }).rule)}'`);
      continue;
    }
    if (!Array.isArray(inv.actors) || inv.actors.length < 2) {
      errors.push('invariants.distinctActors: needs >= 2 actor aliases');
    } else {
      for (const a of inv.actors) if (!aliases.includes(a)) errors.push(`invariants.distinctActors: unknown alias '${a}'`);
    }
  }

  const seedRefs = new Set<string>();
  for (const s of j.seed ?? []) {
    if (!s.ref) errors.push(`seed(${s.sobject}): ref required`);
    else if (seedRefs.has(s.ref)) errors.push(`seed: duplicate ref '${s.ref}'`);
    else seedRefs.add(s.ref);
    if (!s.sobject) errors.push(`seed(${s.ref}): sobject required`);
  }

  if (!Array.isArray(j.steps) || j.steps.length === 0) {
    errors.push('steps: at least one step required');
  } else {
    j.steps.forEach((step, i) => {
      const at = `steps[${i}]`;
      if (isDenyStep(step)) {
        if (!step.deny.actor) errors.push(`${at}.deny.actor: required`);
        else if (aliases.length && !aliases.includes(step.deny.actor)) errors.push(`${at}.deny.actor: unknown alias '${step.deny.actor}'`);
        if (!step.deny.capability) errors.push(`${at}.deny.capability: required`);
      } else {
        const s = step as Partial<ActorStep>;
        if (!s.actor) errors.push(`${at}.actor: required`);
        else if (aliases.length && !aliases.includes(s.actor)) errors.push(`${at}.actor: unknown alias '${s.actor}'`);
        if (!s.do) errors.push(`${at}.do: step-catalog name required`);
        if (s.timing?.notBefore !== undefined && s.timing.notBefore !== 'prevStep') {
          errors.push(`${at}.timing.notBefore: only 'prevStep' is supported (steps are sequential)`);
        }
        if (s.timing?.maxDurationMs !== undefined && !(s.timing.maxDurationMs > 0)) {
          errors.push(`${at}.timing.maxDurationMs: must be > 0`);
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}
