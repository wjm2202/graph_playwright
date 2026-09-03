/**
 * S-GRAPH-2 — v1 → v2 upgrade: activity-node graphs become state-node /
 * relation-edge graphs. This is the LOAD DOOR: v1 files stay openable forever
 * (resolve.ts and the planner run every document through here), but nothing
 * past the door knows the v1 vocabulary — `schema.ts` accepts v2 only, so the
 * v1 shapes are declared HERE, locally, as the converter's input type.
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
 *  - checkpoint nodes are kept, wired via `asserts`; decision/snapshot nodes
 *    become plain `does` relations (the v2 model has no branch/photo node).
 */

import type { PEdge, PNode, ProcessGraph, SystemDef } from './schema';
import { validateGraph } from './schema';

/** The v1 document, as it exists on disk. Declared here and nowhere else. */
export interface V1Node {
  id: string;
  type: 'start' | 'action' | 'decision' | 'checkpoint' | 'snapshot' | 'end';
  label: string;
  system?: string;
  actor?: string;
  account?: { usernameEnv: string };
  url?: string;
  steps?: { status: 'planned' | 'captured'; journeyId?: string };
  snapshot?: { status: 'planned' | 'captured'; ref?: string; capturedAt?: string };
  timing?: { plannedMs?: number; capturedMeanMs?: number; capturedP95Ms?: number };
  /** v1 carried the step-catalog binding on the node; v2 carries it on the edge. */
  catalog?: string;
  notes?: string;
  pos?: { x: number; y: number };
}

export interface V1Edge {
  id: string;
  from: string;
  to: string;
  type: 'next' | 'navigates' | 'handoff' | 'deny';
  label?: string;
  data?: { deltaMs?: number; recordRef?: string; frequency?: number; meanMs?: number; capability?: string };
}

export interface V1Graph {
  schema: 'process-graph/1';
  id: string;
  title?: string;
  systems: Record<string, SystemDef>;
  actors: Record<string, string>;
  nodes: V1Node[];
  edges: V1Edge[];
}

export interface UpgradeResult {
  graph: ProcessGraph;
  warnings: string[];
}

const ACTIONISH = new Set(['action', 'decision', 'checkpoint', 'snapshot']);
const V1_NODE_TYPES = new Set(['start', 'action', 'decision', 'checkpoint', 'snapshot', 'end']);
const V1_EDGE_TYPES = new Set(['next', 'navigates', 'handoff', 'deny']);
const ID_RE = /^[a-z][a-z0-9_]*$/;

/**
 * The v1 half of the validator — referential integrity only, enough to know
 * the conversion is meaningful (the OUTPUT is then validated in full by
 * schema.ts). Kept deliberately small: v1 is a doorway, not a model.
 */
function v1Problems(g: V1Graph): string[] {
  const errors: string[] = [];
  if (!g.id || !ID_RE.test(g.id)) errors.push('id: lower_snake_case required');
  const nodeIds = new Set<string>();
  for (const n of g.nodes ?? []) {
    const at = `nodes.${n?.id ?? '?'}`;
    if (!n?.id || !ID_RE.test(n.id)) errors.push(`${at}: id lower_snake_case required`);
    else if (nodeIds.has(n.id)) errors.push(`${at}: duplicate node id`);
    else nodeIds.add(n.id);
    if (!V1_NODE_TYPES.has(n?.type)) errors.push(`${at}.type: one of ${[...V1_NODE_TYPES].join('|')}`);
    if (n?.system !== undefined && !g.systems?.[n.system]) errors.push(`${at}.system: '${n.system}' not in systems`);
    if (n?.actor !== undefined && !g.actors?.[n.actor]) errors.push(`${at}.actor: '${n.actor}' not in actors`);
  }
  const edgeIds = new Set<string>();
  for (const e of g.edges ?? []) {
    const at = `edges.${e?.id ?? '?'}`;
    if (!e?.id || !ID_RE.test(e.id)) errors.push(`${at}: id lower_snake_case required`);
    else if (edgeIds.has(e.id)) errors.push(`${at}: duplicate edge id`);
    else edgeIds.add(e.id);
    if (!V1_EDGE_TYPES.has(e?.type)) errors.push(`${at}.type: one of ${[...V1_EDGE_TYPES].join('|')}`);
    for (const end of ['from', 'to'] as const) {
      if (!e?.[end] || !nodeIds.has(e[end])) errors.push(`${at}.${end}: unknown node '${e?.[end]}'`);
    }
    if (e?.type === 'deny' && !e.data?.capability) errors.push(`${at}: deny edges require data.capability`);
  }
  return errors;
}

/** v1 in, v2 out. A document that is already v2 comes back untouched. */
export function upgradeGraph(doc: V1Graph | ProcessGraph): UpgradeResult {
  if (doc.schema === 'process-graph/2') {
    const v = validateGraph(doc);
    if (!v.ok) throw new Error(`cannot upgrade an invalid graph:\n - ${v.errors.join('\n - ')}`);
    return { graph: doc, warnings: ['already process-graph/2 — unchanged'] };
  }
  const v1 = doc;
  const problems = v1Problems(v1);
  if (problems.length) throw new Error(`cannot upgrade an invalid graph:\n - ${problems.join('\n - ')}`);

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
        // v1Problems has already proven the capability is there.
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
