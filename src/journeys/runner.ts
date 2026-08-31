/**
 * Journey runner MVP (design doc §4 Option B + §7 baselines).
 *
 * Executes a validated journey: check invariants → seed data → run steps in
 * order (actor steps via the catalog, deny steps via cast.deny + registered
 * deny probes) → emit a per-step report of who did what, how long it took,
 * and which denials were proven.
 *
 * Timing feedback is graded against baselines.json (design doc §7.1):
 *   > p95 × softFactor → step PASSES but is flagged (perf drift made visible)
 *   > p95 × hardFactor → step FAILS FAST with expected-vs-actual
 * plus an optional per-step hard ceiling (timing.maxDurationMs) independent
 * of baselines. Baselines update on green runs — by the capture tooling, not
 * by this runner.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { Lightning } from '../fixtures/test';
import { seedRecords, resolvePlaceholders, type RefMap, type SeedApi } from '../data/seed';
import { StepCatalog } from './catalog';
import { isDenyStep, validateJourney, type Journey } from './schema';
import { evaluateOracles, type ApiOracle, type OracleResult, type OracleSpec } from './oracles';

export interface Budgets {
  softFactor: number;
  hardFactor: number;
}

export interface StepBaseline {
  n: number;
  meanMs: number;
  p95Ms: number;
  updated?: string;
}

export interface Baselines {
  journey: string;
  steps: Record<string, StepBaseline>;
  budgets?: Partial<Budgets>;
}

export const DEFAULT_BUDGETS: Budgets = { softFactor: 1.5, hardFactor: 3.0 };

export type Grade = 'ok' | 'soft' | 'hard';

/** Pure grading: how does an observed duration compare to its baseline? */
export function gradeDuration(ms: number, baseline?: StepBaseline, budgets: Budgets = DEFAULT_BUDGETS): Grade {
  if (!baseline || baseline.p95Ms <= 0) return 'ok';
  if (ms > baseline.p95Ms * budgets.hardFactor) return 'hard';
  if (ms > baseline.p95Ms * budgets.softFactor) return 'soft';
  return 'ok';
}

/** Baseline key: "3:approver/expense.approve" (index:actorAlias/stepName). */
export function baselineKey(index: number, actorAlias: string, stepName: string): string {
  return `${index}:${actorAlias}/${stepName}`;
}

export interface StepReport {
  index: number;
  kind: 'do' | 'deny';
  actorAlias: string;
  personaId: string;
  name: string;
  ms: number;
  status: 'ok' | 'soft-flag' | 'failed';
  note?: string;
  /** Per-oracle outcomes (DESIGN-EXPECTATIONS): the pass/fail truth source. */
  oracles?: OracleResult[];
  /** Path of the step's screenshot when deps.runDir is set. */
  screenshot?: string;
}

export interface JourneyReport {
  journey: string;
  steps: StepReport[];
  flags: string[];
}

/** A failed run still yields its evidence: the partial report rides the error. */
export class JourneyRunError extends Error {
  constructor(message: string, readonly report: JourneyReport) {
    super(message);
    this.name = 'JourneyRunError';
  }
}

export interface CastLike {
  as(personaId: string): Promise<Page>;
  deny: (personaId: string, probe: Parameters<import('../fixtures/cast').Cast['deny']>[1]) => Promise<void>;
  /**
   * Optional: adopt session limits discovered at run time (runGraph derives
   * them from the graph's systems). Optional so the harness's minimal fake
   * casts stay valid — a fake only implements it when it tests policy.
   */
  applySessionPolicies?: (policies: import('../fixtures/cast').SessionPolicies) => void;
}

export interface RunnerDeps {
  cast: CastLike;
  catalog: StepCatalog;
  /** Required when the journey has a seed block. */
  api?: SeedApi;
  baselines?: Baselines;
  /** Known persona ids for validation (defaults to unchecked). */
  personaIds?: string[] | undefined;
  /** Injectable clock for deterministic tests. */
  clock?: () => number;
  /** Injectable sleeper for timing.waitMs choreography. */
  sleep?: (ms: number) => Promise<void>;
  /** When set: per-step screenshots (jpeg) + evidence land in this directory. */
  runDir?: string;
  /** Binds api.record_exists / api.field_equals oracles (one seam). */
  apiOracle?: ApiOracle;
}

export async function runJourney(journey: Journey, deps: RunnerDeps): Promise<JourneyReport> {
  const validation = validateJourney(journey, { personaIds: deps.personaIds });
  if (!validation.ok) {
    throw new Error(`journey '${journey.journey}' invalid:\n - ${validation.errors.join('\n - ')}`);
  }

  // Invariants BEFORE anything runs (design doc §3.2): segregation holds even
  // after pool substitution because bindings are checked at the persona level.
  for (const inv of journey.invariants ?? []) {
    const bound = inv.actors.map((alias) => journey.actors[alias]);
    if (new Set(bound).size !== bound.length) {
      throw new Error(
        `invariant distinctActors violated: [${inv.actors.join(', ')}] resolve to [${bound.join(', ')}] — the same persona cannot hold both roles`,
      );
    }
  }

  const clock = deps.clock ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const budgets: Budgets = { ...DEFAULT_BUDGETS, ...(deps.baselines?.budgets ?? {}) };

  let refs: RefMap = {};
  if (journey.seed?.length) {
    if (!deps.api) throw new Error(`journey '${journey.journey}' has a seed block — provide deps.api`);
    refs = await seedRecords(deps.api, journey.seed);
  }

  const report: JourneyReport = { journey: journey.journey, steps: [], flags: [] };

  const screenshot = async (page: Page | undefined, i: number, name: string, failed = false): Promise<string | undefined> => {
    if (!deps.runDir || !page) return undefined;
    try {
      fs.mkdirSync(deps.runDir, { recursive: true });
      const file = path.join(deps.runDir, `${failed ? 'fail-' : ''}step-${i}-${name.replace(/[^a-z0-9.]+/gi, '_')}.jpg`);
      await page.screenshot({ path: file, type: 'jpeg', quality: 60 });
      return file;
    } catch {
      return undefined; // evidence is best-effort, never the reason a run dies
    }
  };

  for (let i = 0; i < journey.steps.length; i++) {
    const step = journey.steps[i]!; // 0 <= i < length

    if (isDenyStep(step)) {
      const { actor, capability, target } = step.deny;
      const personaId = journey.actors[actor];
      if (!personaId) throw new Error(`actor '${actor}' missing from journey.actors (validateJourney should have caught this)`);
      const t0 = clock();
      try {
        const probeFactory = deps.catalog.denyProbe(capability);
        const probe = probeFactory({
          refs,
          target: resolvePlaceholders(target, refs),
          journey,
          stepIndex: i,
        });
        await deps.cast.deny(personaId, probe); // throws DENY FAILED on leak
      } catch (e) {
        report.steps.push({
          index: i, kind: 'deny', actorAlias: actor, personaId, name: capability,
          ms: clock() - t0, status: 'failed', note: (e as Error).message,
        });
        throw new JourneyRunError((e as Error).message, report);
      }
      report.steps.push({
        index: i,
        kind: 'deny',
        actorAlias: actor,
        personaId,
        name: capability,
        ms: clock() - t0,
        status: 'ok',
        note: 'refusal proven',
      });
      continue;
    }

    const s = step;
    const personaId = journey.actors[s.actor];
    if (!personaId) throw new Error(`actor '${s.actor}' missing from journey.actors (validateJourney should have caught this)`);
    const isAssert = s.do.startsWith('assert.');
    const hasImpl = deps.catalog.stepNames().includes(s.do);
    const oracleSpecs = ((s.expect as { expects?: OracleSpec[] } | undefined)?.expects ?? []);

    let page: Page | undefined;
    const t0 = clock();
    let oracles: OracleResult[] | undefined;
    try {
      const fn = isAssert && !hasImpl ? undefined : deps.catalog.step(s.do);

      if (s.timing?.waitMs) await sleep(s.timing.waitMs);

      page = await deps.cast.as(personaId);
      const args = resolveRecord(s.with ?? {}, refs);
      const expects = resolveRecord(s.expect ?? {}, refs);

      if (fn) {
        await fn({
          page,
          lightning: new Lightning(page),
          cast: deps.cast,
          refs,
          args,
          expects,
          api: deps.api,
          journey,
          stepIndex: i,
        });
      }

      // Central oracle evaluation — every emitted expectation is CHECKED,
      // and assert.* steps run on oracles alone (no catalog entry needed).
      if (oracleSpecs.length) {
        oracles = await evaluateOracles(page, oracleSpecs, { args, api: deps.api }, deps.apiOracle);
        const failed = oracles.filter((o) => o.status === 'fail');
        if (failed.length) {
          throw new Error(
            `oracle${failed.length > 1 ? 's' : ''} failed on '${s.do}': ` +
              failed.map((o) => `${o.id} (${o.message ?? o.kind})`).join('; '),
          );
        }
      }
    } catch (e) {
      const shot = await screenshot(page, i, s.do, true);
      report.steps.push({
        index: i, kind: 'do', actorAlias: s.actor, personaId, name: s.do,
        ms: clock() - t0, status: 'failed', note: (e as Error).message,
        ...(oracles ? { oracles } : {}),
        ...(shot ? { screenshot: shot } : {}),
      });
      throw new JourneyRunError((e as Error).message, report);
    }
    const ms = clock() - t0;

    const shot = await screenshot(page, i, s.do);

    const key = baselineKey(i, s.actor, s.do);
    const baseline = deps.baselines?.steps[key];
    const grade = gradeDuration(ms, baseline, budgets);

    const pushStep = (status: StepReport['status'], note?: string) =>
      report.steps.push({
        index: i, kind: 'do', actorAlias: s.actor, personaId, name: s.do, ms, status,
        ...(note ? { note } : {}),
        ...(oracles ? { oracles } : {}),
        ...(shot ? { screenshot: shot } : {}),
      });

    if (s.timing?.maxDurationMs !== undefined && ms > s.timing.maxDurationMs) {
      const msg = `step ${i} '${s.do}' (${s.actor}) exceeded its hard ceiling: ${ms}ms > maxDurationMs ${s.timing.maxDurationMs}ms`;
      pushStep('failed', msg);
      throw new JourneyRunError(msg, report);
    }
    if (grade === 'hard') {
      const msg = `step ${i} '${s.do}' (${s.actor}) blew the timing budget: ${ms}ms vs baseline p95 ${baseline!.p95Ms}ms × ${budgets.hardFactor} — expected ≤ ${Math.round(baseline!.p95Ms * budgets.hardFactor)}ms`;
      pushStep('failed', msg);
      throw new JourneyRunError(msg, report);
    }

    const flagged = grade === 'soft';
    const note = flagged
      ? `took ${ms}ms, baseline p95 ${baseline!.p95Ms}ms (soft budget ×${budgets.softFactor})`
      : undefined;
    if (flagged) report.flags.push(`step ${i} '${s.do}': ${note}`);
    pushStep(flagged ? 'soft-flag' : 'ok', note);
  }

  return report;
}


function resolveRecord(obj: Record<string, unknown>, refs: RefMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolvePlaceholders(v, refs);
  return out;
}
