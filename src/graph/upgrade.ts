/**
 * S-GRAPH-2 — v1 → v2 upgrade: activity-node graphs become state-node /
 * relation-edge graphs. v1 files stay loadable forever through this converter.
 *
 * Mapping (STUDY-TEST-GRAPH-REPRESENTATION.md §3):
 *  - v1 action-ish nodes group by (system, actor) → one `session` node each;
 *    first-appearance order becomes the `login_as` chain from `start`.
 *  - each v1 action node → a `does` edge from its session (to the shared data
 *    node when a handoff record ties it there, else a self-relation),
 *    carrying catalog/label; steps/snapshot/timing details that lived on the
 *    node are noted as warnings when they can't ride along.
 *  - v1 `deny` edge → `denied` edge from the denied actor's session.
 *  - v1 `handoff` → a `data` node + `touches` from both sessions.
 *  - checkpoint/decision/snapshot nodes are kept, wired via `asserts`.
 */

import type { PEdge, PNode, ProcessGraph } from './schema';
import { validateGraph } from './schema';

export interface UpgradeResult {
  graph: ProcessGraph;
  warnings: string[];
}

const ACTIONISH = new Set(['action', 'decision', 'checkpoint', 'snapshot']);

export function upgradeGraph(v1: ProcessGraph): UpgradeResult {
  const v = validateGraph(v1);
  if (!v.ok) throw new Error(`cannot upgrade an invalid graph:\n - ${v.errors.join('\n - ')}`);
  if (v1.schema === 'process-graph/2') return { graph: v1, warnings: ['already process-graph/2 — unchanged'] };

  const warnings: string[] = [];
  const nodes: PNode[] = [{ id: 'start', type: 'start', label: '' }];
  const edges: PEdge[] = [];
  let e = 0;
  const eid = () => `e${++e}`;

  // 1. Sessions from (system, actor) lanes, in first-appearance order.
  const sessionByLane = new Map<string, PNode>();
  const sessionOf = new Map<string, string>(); // v1 node id → session id
  for (const n of v1.nodes) {
    if (!ACTIONISH.has(n.type) || !n.actor) continue;
    const lane = `${n.system ?? ''}|${n.actor}`;
    if (!sessionByLane.has(lane)) {
      const id = `sess_${(n.system ?? 'app')}_${n.actor}`.replace(/[^a-z0-9_]+/g, '_');
      const label = `${n.system ? (v1.systems[n.system]?.label ?? n.system) : 'app'} · ${n.actor}`;
      sessionByLane.set(lane, {
        id, type: 'session', label,
        ...(n.system ? { system: n.system } : {}),
        actor: n.actor,
        ...(n.account ? { account: n.account } : {}),
      });
    } else if (n.account && !sessionByLane.get(lane)!.account) {
      sessionByLane.get(lane)!.account = n.account;
    }
    sessionOf.set(n.id, sessionByLane.get(lane)!.id);
  }
  const chain = [...sessionByLane.values()];
  nodes.push(...chain);
  chain.forEach((s, i) => {
    edges.push({ id: eid(), from: i === 0 ? 'start' : (chain[i - 1]?.id ?? 'start'), to: s.id, type: 'login_as' });
  });

  // 2. Data nodes from handoff record refs.
  const dataByRef = new Map<string, string>();
  for (const edge of v1.edges) {
    const ref = edge.data?.recordRef;
    if (edge.type === 'handoff' && ref && !dataByRef.has(ref)) {
      const id = `data_${ref.toLowerCase().replace(/[^a-z0-9_]+/g, '_')}`.slice(0, 60);
      dataByRef.set(ref, id);
      nodes.push({ id, type: 'data', label: `record ${ref}` });
    }
  }
  const sharedData = dataByRef.size === 1 ? [...dataByRef.values()][0] : undefined;

  // 3. v1 action nodes → does relations (declaration order = timeline).
  for (const n of v1.nodes) {
    if (!ACTIONISH.has(n.type)) continue;
    const sess = sessionOf.get(n.id);
    if (!sess) { warnings.push(`node '${n.id}' has no actor — dropped from the v2 timeline`); continue; }
    if (n.type === 'checkpoint') {
      nodes.push({ id: n.id, type: 'checkpoint', label: n.label });
      edges.push({ id: eid(), from: sess, to: n.id, type: 'asserts', label: n.label });
      continue;
    }
    edges.push({
      id: eid(), from: sess, to: sharedData ?? sess, type: 'does',
      label: n.label,
      data: { ...(n.catalog ? { catalog: n.catalog } : {}) },
    });
    if (n.steps || n.snapshot || n.timing?.plannedMs) {
      warnings.push(`node '${n.id}': steps/snapshot/planned timing noted but not carried onto the does edge — re-enter in the planner if needed`);
    }
  }

  // 4. deny → denied; handoff → touches from both ends' sessions.
  for (const edge of v1.edges) {
    if (edge.type === 'deny') {
      const sess = sessionOf.get(edge.from);
      if (!sess) { warnings.push(`deny edge '${edge.id}' source has no session — dropped`); continue; }
      edges.push({
        id: eid(), from: sess, to: sharedData ?? sess, type: 'denied',
        data: { capability: edge.data!.capability!, ...(edge.data?.recordRef ? { recordRef: edge.data.recordRef } : {}) },
      });
    } else if (edge.type === 'handoff' && edge.data?.recordRef) {
      const dataId = dataByRef.get(edge.data.recordRef)!;
      for (const end of [edge.from, edge.to]) {
        const sess = sessionOf.get(end);
        if (sess) edges.push({ id: eid(), from: sess, to: dataId, type: 'touches' });
      }
    }
  }

  if (chain.length) {
    nodes.push({ id: 'end', type: 'end', label: '' });
    edges.push({ id: eid(), from: chain[chain.length - 1]?.id ?? 'start', to: 'end', type: 'next' });
  }

  const graph: ProcessGraph = {
    schema: 'process-graph/2',
    id: v1.id,
    ...(v1.title ? { title: v1.title } : {}),
    systems: v1.systems,
    actors: v1.actors,
    nodes,
    edges,
  };
  const gv = validateGraph(graph);
  if (!gv.ok) throw new Error(`upgrade produced an invalid graph (bug):\n - ${gv.errors.join('\n - ')}`);
  return { graph, warnings };
}
