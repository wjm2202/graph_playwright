/**
 * PG-3 — plan graph → executable context (design doc §3.4).
 *
 * Walks the graph's next/navigates spine into a journey skeleton: nodes with a
 * catalog binding become real steps; unbound nodes become `plan.<node_id>`
 * placeholder steps the recorder/binding session fills. Deny edges become
 * journey deny steps (actor = the edge's FROM lane). Systems with session
 * policies come out as Cast session-policy groups — Siebel's max-1 becomes an
 * enforceable constraint, not tribal knowledge.
 *
 * v1 scope, loudly enforced: one linear spine (no branching — split decision
 * paths into separate graphs/journeys), no cycles, every executable node needs
 * an actor lane.
 */

import type { Journey, JourneyStep } from '../journeys/schema';
import { validateJourney } from '../journeys/schema';
import type { SessionPolicies, SessionPolicyGroup } from '../fixtures/cast';
import type { AuthMethod, ProcessGraph, PNode } from './schema';
import { validateGraph } from './schema';
import { dataflowHealth } from './compose';

export type { SessionPolicies, SessionPolicyGroup };

export interface ToJourneyOptions {
  personaIds?: string[] | undefined;
  /** persona → auth method (personas.json). Enables the login_as agreement
   *  check; omit and that check is skipped. */
  personaAuth?: Record<string, AuthMethod | undefined> | undefined;
}

export interface ToJourneyResult {
  journey: Journey;
  /** Placeholder step names (plan.<id>) awaiting catalog bindings. */
  unboundSteps: string[];
  sessionPolicies: SessionPolicies;
  /** v2 `requires` prerequisite relations (→ Playwright project deps later). */
  requires: { from: string; to: string }[];
  /** Step index → source edge id (v2) — the merge-back mapping. */
  stepEdgeIds: (string | null)[];
  warnings: string[];
}

// The spine = sequencing edges. handoff sequences too (a record crossing
// actors/systems IS the handover); only deny edges sit outside the flow.
const SPINE = new Set(['next', 'navigates', 'handoff']);
const EXECUTABLE = new Set(['action', 'decision', 'checkpoint', 'snapshot']);

export function toJourney(graph: ProcessGraph, opts: ToJourneyOptions = {}): ToJourneyResult {
  const gv = validateGraph(graph, { personaAuth: opts.personaAuth });
  if (!gv.ok) throw new Error(`graph invalid:\n - ${gv.errors.join('\n - ')}`);
  if (graph.schema === 'process-graph/2') return toJourneyV2(graph, opts);

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const spineOut = new Map<string, string[]>();
  const spineIn = new Map<string, number>();
  for (const e of graph.edges) {
    if (!SPINE.has(e.type)) continue;
    if (!spineOut.has(e.from)) spineOut.set(e.from, []);
    spineOut.get(e.from)!.push(e.to);
    spineIn.set(e.to, (spineIn.get(e.to) ?? 0) + 1);
  }

  for (const [from, outs] of spineOut) {
    if (outs.length > 1) {
      throw new Error(
        `node '${from}' branches into [${outs.join(', ')}] — branching is not supported in v1: split each decision path into its own graph/journey`,
      );
    }
  }

  const starts = graph.nodes.filter(
    (n) => (spineOut.get(n.id)?.length ?? 0) + 0 >= 0 && !spineIn.has(n.id) && (n.type === 'start' || EXECUTABLE.has(n.type)),
  ).filter((n) => spineOut.has(n.id) || EXECUTABLE.has(n.type));
  if (starts.length === 0) throw new Error('no start of the spine found (a node with no incoming next/navigates)');
  if (starts.length > 1) {
    throw new Error(`multiple spine starts: [${starts.map((n) => n.id).join(', ')}] — one linear spine per graph in v1`);
  }

  const order: PNode[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined = starts[0]?.id;
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`cycle detected at node '${cursor}' — journeys are acyclic`);
    seen.add(cursor);
    order.push(nodeById.get(cursor)!);
    cursor = spineOut.get(cursor)?.[0];
  }

  const warnings: string[] = [];
  const unboundSteps: string[] = [];
  const steps: JourneyStep[] = [];
  const denyByFrom = new Map<string, JourneyStep[]>();
  for (const e of graph.edges) {
    if (e.type !== 'deny') continue;
    const fromNode = nodeById.get(e.from)!;
    if (!fromNode.actor) throw new Error(`deny edge '${e.id}': from-node '${e.from}' has no actor lane`);
    if (!denyByFrom.has(e.from)) denyByFrom.set(e.from, []);
    denyByFrom.get(e.from)!.push({
      deny: {
        actor: fromNode.actor,
        capability: e.data!.capability!,
        ...(e.data?.recordRef !== undefined ? { target: e.data.recordRef } : {}),
      },
    });
  }

  for (const n of order) {
    if (n.type === 'start' || n.type === 'end') continue;
    if (!EXECUTABLE.has(n.type)) continue;
    if (!n.actor) throw new Error(`node '${n.id}' (${n.label || n.type}) has no actor — every executable node needs a lane`);
    const doName = n.catalog ?? `plan.${n.id}`;
    if (!n.catalog) unboundSteps.push(doName);
    const withArgs: Record<string, unknown> = {};
    if (n.url) withArgs.url = n.url;
    steps.push({ actor: n.actor, do: doName, ...(Object.keys(withArgs).length ? { with: withArgs } : {}) });
    for (const d of denyByFrom.get(n.id) ?? []) steps.push(d);
  }
  if (steps.length === 0) throw new Error('graph produced no executable steps');

  const journey: Journey = {
    journey: graph.id,
    ...(graph.title ? { description: graph.title } : {}),
    actors: graph.actors,
    steps,
  };
  const jv = validateJourney(journey, { personaIds: opts.personaIds });
  if (!jv.ok) throw new Error(`exported journey invalid (bug):\n - ${jv.errors.join('\n - ')}`);

  const sessionPolicies = sessionPoliciesFromGraph(graph);
  for (const g of sessionPolicies.groups) {
    if (g.personas.length > g.maxConcurrent) {
      warnings.push(
        `system '${g.system}' allows ${g.maxConcurrent} session(s) but ${g.personas.length} personas use it [${g.personas.join(', ')}] — Cast will logout-to-comply (LRU) between their steps`,
      );
    }
  }
  if (unboundSteps.length) {
    warnings.push(`unbound plan steps need catalog bindings before running: ${unboundSteps.join(', ')}`);
  }

  return { journey, unboundSteps, sessionPolicies, requires: [], stepEdgeIds: steps.map(() => null), warnings };
}

/**
 * v2 walker: the `login_as` chain is the actor timeline; each session's
 * outgoing `does`/`denied` edges (declaration order) are that actor's steps.
 * `touches`/`asserts` are relations, not steps; `requires` comes back as
 * prerequisite metadata.
 */
function toJourneyV2(graph: ProcessGraph, opts: ToJourneyOptions): ToJourneyResult {
  const warnings: string[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Login chain from start (linear, acyclic).
  const loginOut = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type !== 'login_as') continue;
    if (!loginOut.has(e.from)) loginOut.set(e.from, []);
    loginOut.get(e.from)!.push(e.to);
  }
  for (const [from, outs] of loginOut) {
    if (outs.length > 1) {
      throw new Error(`'${from}' has ${outs.length} outgoing login_as edges — one linear session chain per graph in v1 of the walker`);
    }
  }
  const startNode = graph.nodes.find((n) => n.type === 'start');
  if (!startNode) throw new Error("v2 graphs need a 'start' node to anchor the login_as chain");

  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = loginOut.get(startNode.id)?.[0];
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`login_as cycle at '${cursor}'`);
    seen.add(cursor);
    chain.push(cursor);
    cursor = loginOut.get(cursor)?.[0];
  }
  if (chain.length === 0) throw new Error('no login_as chain found — connect start to the first session');

  // Dataflow: who defines each data node decides what a consumer receives.
  const dataflow = dataflowHealth(graph);
  for (const err of dataflow.errors) warnings.push(`dataflow: ${err}`);
  for (const w of dataflow.warnings) warnings.push(`dataflow: ${w}`);

  const steps: JourneyStep[] = [];
  const unboundSteps: string[] = [];
  const stepEdgeIds: (string | null)[] = [];
  for (const sessId of chain) {
    const sess = nodeById.get(sessId)!;
    if (!sess.actor) throw new Error(`session '${sessId}' has no actor — every session needs a role/user`);
    for (const e of graph.edges) {
      if (e.from !== sessId) continue;
      if (e.type === 'does') {
        const doName = e.data?.catalog ?? `plan.${e.id}`;
        if (!e.data?.catalog) unboundSteps.push(doName);
        const target = nodeById.get(e.to);
        const withArgs: Record<string, unknown> = {};
        if (target?.type === 'data') {
          // The PORT decides what the step receives (STUDY-DATA-FLOW.md §3.3):
          // consumes/updates → the runtime handle (bind map, or the default
          // { record: '{ref:<ref>.id}' }); produces → the step publishes the
          // record via ctx.produce(<ref>) and gets the handle name to use;
          // no port (legacy) → the label, as before.
          const ref = target.ref ?? target.id;
          const io = e.data?.io;
          const definedBy = dataflow.definedBy[target.id];
          if ((io === 'consumes' || io === 'updates') && definedBy?.startsWith('ambient:') && !e.data?.bind) {
            // Created by an integration hop (api → data): the run never learns
            // its id, so the step must locate it by business key.
            withArgs.record = target.label;
            if (target.sobject) withArgs.sobject = target.sobject;
            warnings.push(`dataflow: '${doName}' ${io} '${target.label || target.id}', which an integration creates (${definedBy.slice(8)}) — no id reaches the run; the step must find it by business key (or bind an explicit {ref:} on the edge)`);
          } else if (io === 'consumes' || io === 'updates') {
            Object.assign(withArgs, e.data?.bind ?? { record: `{ref:${ref}.id}` });
          } else if (io === 'produces') {
            withArgs.produce = ref;
            if (target.sobject) withArgs.sobject = target.sobject;
          } else {
            withArgs.record = target.label;
          }
        }
        // Oracle placement: the landing node's expectations become this step's
        // expect block (filtered by `after` = this edge's id or catalog).
        const oracles = expectationsFor(target, e.id, e.data?.catalog);
        steps.push({
          actor: sess.actor,
          do: doName,
          ...(Object.keys(withArgs).length ? { with: withArgs } : {}),
          ...(oracles.length ? { expect: { expects: oracles } } : {}),
        });
        stepEdgeIds.push(e.id);
      } else if (e.type === 'asserts') {
        const target = nodeById.get(e.to);
        if (target?.type === 'checkpoint') {
          // assert.* steps run on their oracles alone — the runner evaluates
          // them centrally, no catalog entry required.
          const oracles = expectationsFor(target, e.id, undefined, true);
          steps.push({
            actor: sess.actor,
            do: `assert.${target.id}`,
            ...(oracles.length ? { expect: { expects: oracles } } : {}),
          });
          stepEdgeIds.push(e.id);
        }
      } else if (e.type === 'denied') {
        steps.push({
          deny: {
            actor: sess.actor,
            capability: e.data!.capability!,
            ...(e.data?.recordRef !== undefined ? { target: e.data.recordRef } : {}),
          },
        });
        stepEdgeIds.push(e.id);
      }
    }
  }
  if (steps.length === 0) throw new Error('graph produced no executable steps (no does/denied edges on the session chain)');

  const journey: Journey = {
    journey: graph.id,
    ...(graph.title ? { description: graph.title } : {}),
    actors: graph.actors,
    steps,
  };
  const jv = validateJourney(journey, { personaIds: opts.personaIds });
  if (!jv.ok) throw new Error(`exported journey invalid (bug):\n - ${jv.errors.join('\n - ')}`);

  const sessionPolicies = sessionPoliciesFromGraph(graph);
  for (const g of sessionPolicies.groups) {
    if (g.personas.length > g.maxConcurrent) {
      warnings.push(
        `system '${g.system}' allows ${g.maxConcurrent} session(s) but ${g.personas.length} personas use it [${g.personas.join(', ')}] — Cast will logout-to-comply (LRU) between their steps`,
      );
    }
  }
  if (unboundSteps.length) warnings.push(`unbound plan steps need catalog bindings before running: ${unboundSteps.join(', ')}`);

  const requires = graph.edges.filter((e) => e.type === 'requires').map((e) => ({ from: e.from, to: e.to }));
  if (requires.length) {
    warnings.push(`prerequisites declared (${requires.length}) — wire them as Playwright project dependencies when binding`);
  }

  return { journey, unboundSteps, sessionPolicies, requires, stepEdgeIds, warnings };
}

/** The landing node's oracles for one edge, with placement filtering applied. */
function expectationsFor(
  target: PNode | undefined,
  edgeId: string,
  catalog: string | undefined,
  includeAll = false,
): Record<string, unknown>[] {
  if (!target?.expects?.length) return [];
  return target.expects
    .filter((x) => includeAll || !x.after || x.after === edgeId || x.after === catalog)
    .map(({ id, kind, target: t, value, note, timeoutMs, pollMs }) => ({
      id, kind,
      ...(t !== undefined ? { target: t } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(note !== undefined ? { note } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(pollMs !== undefined ? { pollMs } : {}),
    }));
}

/** Cast session-policy groups from a graph's systems + actor lanes. */
export function sessionPoliciesFromGraph(graph: ProcessGraph): SessionPolicies {
  const groups: SessionPolicyGroup[] = [];
  for (const [sysId, sys] of Object.entries(graph.systems)) {
    if (!sys.sessionPolicy) continue;
    const personas = [
      ...new Set(
        graph.nodes
          .filter((n) => n.system === sysId && n.actor)
          .map((n) => graph.actors[n.actor!])
          .filter((p): p is string => !!p),
      ),
    ];
    if (personas.length) {
      groups.push({ system: sysId, maxConcurrent: sys.sessionPolicy.maxConcurrent, personas });
    }
  }
  return { groups };
}
