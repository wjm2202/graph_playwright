/**
 * Merge-back — a run's evidence flows onto the plan graph, automatically:
 *  - per-oracle results paint each expectation's lastResult (pass/fail);
 *    when a step failed without per-oracle detail, its oracles paint fail
 *  - the acting session's steps placeholder flips planned → captured with
 *    the journey id; edges record the last observed duration (data.lastMs
 *    stays out of the schema — captured timing goes to node.timing)
 *  - step screenshots are COPIED into the graph's evidence folder and the
 *    node's snapshot slot keeps the relative ref (src/graph/evidence.ts), so
 *    the planner shows what the run saw and the graph stays readable
 *
 * Mapping is exact, not heuristic: toJourney() returns stepEdgeIds — step i
 * came from edge stepEdgeIds[i]; the edge's endpoints are the nodes to paint.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { JourneyReport } from '../journeys/runner';
import type { ProcessGraph } from './schema';
import { validateGraph } from './schema';
import { EVIDENCE_DIR, evidenceRef } from './evidence';

/** runIds with this prefix mark SIMULATED evidence (src/graph/simulate.ts).
 *  Core owns the convention because merge-back treats it specially: a real
 *  run's SKIPPED oracle retires simulated paint it cannot re-verify. */
export const SIMULATED_RUN_PREFIX = 'sim_';

export interface MergeOptions {
  /** Journey id this run executed (stamped onto captured placeholders). */
  journeyId: string;
  /** Step index → edge id (from toJourney().stepEdgeIds). */
  stepEdgeIds: (string | null)[];
  runId?: string;
  /**
   * Absolute `<graph root>/evidence` directory (evidenceDirFor(graphFile)).
   * SET: screenshots are copied to `<dir>/<graphId>/<runId>/<node>.jpg` and
   * the node keeps the relative ref. UNSET: the legacy inline data URL, for
   * callers with no graph file to hang evidence off (runGraph on an
   * in-memory graph, unit tests).
   */
  evidenceDir?: string;
  /** Skip INLINE snapshot embedding above this many bytes (default 300KB). */
  maxSnapshotBytes?: number;
  now?: string;
}

export interface MergeResult {
  graph: ProcessGraph;
  changes: string[];
}

export function mergeRunIntoGraph(graph: ProcessGraph, report: JourneyReport, opts: MergeOptions): MergeResult {
  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`cannot merge into an invalid graph:\n - ${v.errors.join('\n - ')}`);

  const g: ProcessGraph = JSON.parse(JSON.stringify(graph)) as ProcessGraph;
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(g.edges.map((e) => [e.id, e]));
  const changes: string[] = [];
  const at = opts.now ?? new Date().toISOString();
  const maxBytes = opts.maxSnapshotBytes ?? 300_000;
  // Every run gets its own evidence folder; a run with no id still gets one
  // (`run`) rather than scattering images at the graph's root.
  const runFolder = (opts.runId ?? 'run').replace(/[^a-z0-9_.-]+/gi, '_');

  for (const step of report.steps) {
    const edgeId = opts.stepEdgeIds[step.index];
    if (!edgeId) continue;
    const edge = edgeById.get(edgeId);
    if (!edge) { changes.push(`step ${step.index}: edge '${edgeId}' no longer in graph — skipped`); continue; }
    const target = nodeById.get(edge.to);
    const session = nodeById.get(edge.from);

    // 1. Oracle results → the target node's expectations.
    if (target?.expects?.length) {
      // The step in hand IS the record — never re-index report.steps by
      // step.index (partial/sparse reports would misalign or crash).
      const emitted = new Set((step.oracles ?? []).map((o) => o.id));
      for (const x of target.expects) {
        const oracle = step.oracles?.find((o) => o.id === x.id);
        if (oracle && oracle.status !== 'skipped') {
          x.lastResult = { status: oracle.status, at, ...(opts.runId ? { runId: opts.runId } : {}), ...(oracle.message ? { message: oracle.message } : {}) };
          changes.push(`${target.id}.${x.id}: ${oracle.status}`);
        } else if (
          oracle?.status === 'skipped' &&
          x.lastResult?.runId?.startsWith(SIMULATED_RUN_PREFIX) &&
          !(opts.runId ?? '').startsWith(SIMULATED_RUN_PREFIX)
        ) {
          // A REAL run could not evaluate this check — simulated green must
          // not outlive it, or the planner shows "verified" forever for a
          // check nothing can verify here. (A real prior result is kept:
          // a later skip carries no evidence against it.)
          delete x.lastResult;
          changes.push(`${target.id}.${x.id}: simulated paint cleared (skipped — ${oracle.message ?? 'not evaluable here'})`);
        } else if (step.status === 'failed' && !emitted.has(x.id) && step.note && wasEmittedFor(x, edge.id, edge.data?.catalog)) {
          x.lastResult = { status: 'fail', at, ...(opts.runId ? { runId: opts.runId } : {}), message: step.note.slice(0, 200) };
          changes.push(`${target.id}.${x.id}: fail (step failed before oracle detail)`);
        }
      }
    }

    // 2. Captured status on the acting session.
    if (session?.type === 'session' && step.kind === 'do' && step.status !== 'failed') {
      const before = session.steps?.status;
      session.steps = { status: 'captured', journeyId: opts.journeyId, ...(session.steps?.stepIndexes ? { stepIndexes: session.steps.stepIndexes } : {}) };
      if (before !== 'captured') changes.push(`${session.id}: steps ${before ?? 'unset'} → captured (${opts.journeyId})`);
    }

    // 3. Observed duration → the acting session's captured timing.
    if (session && step.kind === 'do') {
      session.timing = { ...(session.timing ?? {}), capturedMeanMs: step.ms };
    }

    // 4. Screenshot evidence → snapshot slots (checkpoint target wins, else session).
    if (step.screenshot && fs.existsSync(step.screenshot)) {
      const holder = target?.type === 'checkpoint' ? target : session;
      if (holder) {
        const raw = fs.readFileSync(step.screenshot);
        if (opts.evidenceDir) {
          // A FILE, and a short ref: the graph diff stays readable and the
          // image is beside every other artefact of this run.
          const dir = path.join(opts.evidenceDir, g.id, runFolder);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${holder.id}.jpg`), raw);
          const ref = evidenceRef(g.id, runFolder, holder.id, path.basename(opts.evidenceDir) || EVIDENCE_DIR);
          holder.snapshot = { status: 'captured', ref, capturedAt: at };
          changes.push(`${holder.id}: snapshot captured (${Math.round(raw.length / 1024)}KB → ${ref})`);
        } else if (raw.length <= maxBytes) {
          holder.snapshot = { status: 'captured', ref: `data:image/jpeg;base64,${raw.toString('base64')}`, capturedAt: at };
          changes.push(`${holder.id}: snapshot captured (${Math.round(raw.length / 1024)}KB)`);
        } else {
          changes.push(`${holder.id}: snapshot skipped (${Math.round(raw.length / 1024)}KB > ${Math.round(maxBytes / 1024)}KB)`);
        }
      }
    }
  }

  const gv = validateGraph(g);
  if (!gv.ok) throw new Error(`merge produced an invalid graph (bug):\n - ${gv.errors.join('\n - ')}`);
  return { graph: g, changes };
}

function wasEmittedFor(x: { after?: string }, edgeId: string, catalog?: string): boolean {
  return !x.after || x.after === edgeId || x.after === catalog;
}
