/**
 * runGraph — the one-call automated loop: plan graph → journey → run (with
 * screenshots + central oracles) → merge the evidence back onto the graph.
 * A FAILED run merges too (JourneyRunError carries the partial report), so
 * red paint is just as automatic as green.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runJourney, JourneyRunError, type JourneyReport, type RunnerDeps } from '../journeys/runner';
import { toJourney } from './toJourney';
import { mergeRunIntoGraph, type MergeResult } from './mergeRun';
import type { AuthMethod, ProcessGraph } from './schema';
import { runId } from '../utils/naming';
import { recordEvent } from '../telemetry';

export interface RunGraphResult extends MergeResult {
  report: JourneyReport;
  /** Rethrow-worthy failure (the graph is already painted red). */
  error?: JourneyRunError;
}

export async function runGraph(
  graph: ProcessGraph,
  deps: Omit<RunnerDeps, 'personaIds'> & {
    personaIds?: string[] | undefined;
    /** persona → auth method (PersonaRegistry.authMethods()) — enables the
     *  login_as agreement check while walking. */
    personaAuth?: Record<string, AuthMethod | undefined> | undefined;
    /** Persona-matrix variant: alias → persona id, replacing graph.actors for THIS run (expandVariants). */
    actorOverrides?: Record<string, string> | undefined;
    /** Names the variant in the report / telemetry ("client_lead"). */
    variant?: string | undefined;
  },
): Promise<RunGraphResult> {
  // A persona-matrix variant is ONE binding for THIS walk. The graph that is
  // painted and saved stays the original — default actors and the matrix
  // intact — or the first variant run would overwrite the roster on disk.
  let walkGraph = graph;
  if (deps.actorOverrides) {
    for (const alias of Object.keys(deps.actorOverrides)) {
      if (!(alias in graph.actors)) throw new Error(`actorOverrides: alias '${alias}' is not in the graph's actors (${Object.keys(graph.actors).join(', ')})`);
    }
    const { alternatives: _matrix, ...rest } = graph; // the validator would refuse an alternative equal to the new default
    void _matrix;
    walkGraph = { ...rest, actors: { ...graph.actors, ...deps.actorOverrides } };
  }
  const walked = toJourney(walkGraph, {
    personaIds: deps.personaIds,
    ...(deps.personaAuth ? { personaAuth: deps.personaAuth } : {}),
  });

  // The graph is the source of truth for concurrency: a system declaring
  // maxConcurrent 1 (Siebel-style) must actually evict, not merely warn.
  // Applied BEFORE the first step so no session escapes the limit.
  deps.cast.applySessionPolicies?.(walked.sessionPolicies);

  let report: JourneyReport;
  let error: JourneyRunError | undefined;
  try {
    report = await runJourney(walked.journey, deps);
  } catch (e) {
    if (e instanceof JourneyRunError) {
      report = e.report;
      error = e;
    } else {
      throw e; // config/wiring problems have no evidence to merge
    }
  }

  const merged = mergeRunIntoGraph(graph, report, {
    journeyId: walked.journey.journey,
    stepEdgeIds: walked.stepEdgeIds,
    runId: runId(),
  });

  if (deps.runDir) {
    fs.mkdirSync(deps.runDir, { recursive: true });
    fs.writeFileSync(path.join(deps.runDir, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  }

  return { ...merged, report, ...(error ? { error } : {}) };
}

/** File flavor: load, run, save the painted graph in place + the report. */
export async function runGraphFile(
  graphFile: string,
  deps: Parameters<typeof runGraph>[1],
): Promise<RunGraphResult> {
  const graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')) as ProcessGraph;
  const started = Date.now();
  const result = await runGraph(graph, deps);
  fs.writeFileSync(graphFile, JSON.stringify(result.graph, null, 2) + '\n');
  // Labour telemetry: real graph runs mark the scaffold→green wall clock.
  const green =
    !result.error &&
    result.report.steps.every((s) => s.status !== 'failed') &&
    result.report.steps.every((s) => (s.oracles ?? []).every((o) => o.status !== 'fail'));
  recordEvent({ kind: 'run', id: deps.variant ? `${graph.id}@${deps.variant}` : graph.id, ok: green, ms: Date.now() - started });
  return result;
}
