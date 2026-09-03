/**
 * Simulated run — exercise the full plan→green→spec toolchain WITHOUT an org.
 *
 * A simulated run fabricates the one thing a real org would have produced —
 * a passing JourneyReport — and pushes it through the SAME code path a real
 * run uses: toJourney() walks the graph, mergeRunIntoGraph() paints it
 * (captured sessions, green oracles, snapshots, timing). Nothing here
 * re-implements paint semantics; if merge-back changes, simulation follows.
 *
 * Honesty rules:
 *  - every painted lastResult carries a `sim_`-prefixed runId and a
 *    "simulated" message — evidence is never mistakable for a real run;
 *  - durations are deterministic (baseMs + index step), never measured;
 *  - labour telemetry is NOT written (scaffold→first-green stats must only
 *    ever reflect real capture work).
 */

import { toJourney } from './toJourney';
import { mergeRunIntoGraph, SIMULATED_RUN_PREFIX, type MergeResult } from './mergeRun';
import type { AuthMethod, ProcessGraph } from './schema';
import { isDenyStep, type Journey } from '../journeys/schema';
import type { JourneyReport, StepReport } from '../journeys/runner';
import type { OracleResult, OracleSpec } from '../journeys/oracles';

// The prefix convention lives in mergeRun (core treats it specially on merge);
// re-exported here so simulation callers keep one import site.
export { SIMULATED_RUN_PREFIX } from './mergeRun';

export interface SimulateOptions {
  /** Stamped into every painted lastResult; `sim_` is prefixed when absent. */
  runId?: string;
  /** ISO timestamp for the paint (defaults to now — pass one for determinism). */
  now?: string;
  /** Deterministic duration basis: step i reports baseMs + i*137 ms. */
  baseMs?: number;
  /** Per-step-index screenshot file paths (jpeg) to attach as snapshots. */
  screenshots?: (string | undefined)[];
  /** `<graph root>/evidence` (evidenceDirFor(graphFile)): simulated evidence
   *  is written to files under `<dir>/<graphId>/sim_<run>/` exactly as a real
   *  run's is. Unset = the legacy inline data URL. */
  evidenceDir?: string;
  personaIds?: string[] | undefined;
  personaAuth?: Record<string, AuthMethod | undefined> | undefined;
}

export interface SimulatedWalk {
  journey: Journey;
  stepEdgeIds: (string | null)[];
  report: JourneyReport;
  warnings: string[];
  runId: string;
}

export interface SimulateResult extends MergeResult, SimulatedWalk {}

/** Ensure the runId is visibly simulated wherever it ends up. */
export function simulatedRunId(id?: string): string {
  const raw = id ?? 'local';
  return raw.startsWith(SIMULATED_RUN_PREFIX) ? raw : `${SIMULATED_RUN_PREFIX}${raw}`;
}

/**
 * Walk the graph and fabricate the passing report a real run would produce.
 * Pure: no fs, no clock (durations derive from step index alone).
 */
export function simulateReport(graph: ProcessGraph, opts: SimulateOptions = {}): SimulatedWalk {
  const walked = toJourney(graph, {
    personaIds: opts.personaIds,
    ...(opts.personaAuth ? { personaAuth: opts.personaAuth } : {}),
  });
  const baseMs = opts.baseMs ?? 1100;
  const runId = simulatedRunId(opts.runId);

  const steps: StepReport[] = walked.journey.steps.map((step, index) => {
    const ms = baseMs + index * 137;
    if (isDenyStep(step)) {
      const personaId = walked.journey.actors[step.deny.actor];
      if (!personaId) throw new Error(`actor '${step.deny.actor}' missing from journey.actors`);
      return {
        index, kind: 'deny', actorAlias: step.deny.actor, personaId,
        name: step.deny.capability, ms, status: 'ok', note: 'refusal proven (simulated)',
      };
    }
    const personaId = walked.journey.actors[step.actor];
    if (!personaId) throw new Error(`actor '${step.actor}' missing from journey.actors`);
    const specs = (step.expect as { expects?: OracleSpec[] } | undefined)?.expects ?? [];
    const oracles: OracleResult[] = specs.map((x) => ({
      id: x.id, kind: x.kind, status: 'pass', message: 'simulated',
    }));
    const screenshot = opts.screenshots?.[index];
    return {
      index, kind: 'do', actorAlias: step.actor, personaId, name: step.do, ms, status: 'ok',
      ...(oracles.length ? { oracles } : {}),
      ...(screenshot ? { screenshot } : {}),
    };
  });

  return {
    journey: walked.journey,
    stepEdgeIds: walked.stepEdgeIds,
    report: { journey: walked.journey.journey, steps, flags: [] },
    warnings: walked.warnings,
    runId,
  };
}

/** Simulate + merge: returns the painted graph exactly as a real green run would. */
export function simulateRun(graph: ProcessGraph, opts: SimulateOptions = {}): SimulateResult {
  const walk = simulateReport(graph, opts);
  const merged = mergeRunIntoGraph(graph, walk.report, {
    journeyId: walk.journey.journey,
    stepEdgeIds: walk.stepEdgeIds,
    runId: walk.runId,
    ...(opts.evidenceDir ? { evidenceDir: opts.evidenceDir } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { ...merged, ...walk };
}

/** Marker every simulated generated-steps module carries (overwrite guard). */
export const SIMULATED_MODULE_MARKER = 'SIMULATED placeholder vocabulary';

/**
 * Emit the generated-steps module the emitted spec will `require()`. Every
 * step/deny-probe THROWS on use: the module documents the vocabulary and
 * keeps the spec's binding path honest, without pretending a capture exists.
 */
export function generatedStepsModule(graph: ProcessGraph): string {
  const stepNames: string[] = [];
  const denyCaps: string[] = [];
  for (const e of graph.edges) {
    if (e.type === 'does' && e.data?.catalog && !stepNames.includes(e.data.catalog)) {
      stepNames.push(e.data.catalog);
    }
    if (e.type === 'denied' && e.data?.capability && !denyCaps.includes(e.data.capability)) {
      denyCaps.push(e.data.capability);
    }
  }

  const regs = [
    ...stepNames.map((n) => `    .register('${n}', simulated('${n}'))`),
    ...denyCaps.map((c) => `    .registerDeny('${c}', simulatedDeny('${c}'))`),
  ].join('\n');

  return `/**
 * GENERATED for graph '${graph.id}' — ${SIMULATED_MODULE_MARKER}.
 * Written by \`npx sfpw simulate ${graph.id}\`; every entry THROWS on
 * use. Replace it with real captures: record each session
 * (npx sfpw record <persona> ${graph.id}), then
 * run the pipeline — its generated module overwrites this one.
 */
import type { StepCatalog, StepFn } from '../catalog';

export function registerSteps_${graph.id}(catalog: StepCatalog): StepCatalog {
  return catalog
${regs};
}

function simulated(name: string): StepFn {
  return () =>
    Promise.reject(
      new Error(\`step '\${name}' is a simulated placeholder — record the real flow and re-run the pipeline to implement it\`),
    );
}
${denyCaps.length ? `
function simulatedDeny(capability: string): () => never {
  return () => {
    throw new Error(\`deny probe '\${capability}' is a simulated placeholder — capture the real refusal (RECORD_EXPECT_DENIAL=1) to implement it\`);
  };
}
` : ''}`;
}
