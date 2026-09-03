/**
 * PG-3 — plan graph → executable context (design doc §3.4).
 *
 * The `login_as` chain is the actor timeline; each session's outgoing
 * `does`/`denied` edges (declaration order) are that actor's steps. A `does`
 * without a catalog binding becomes a `plan.<edge_id>` placeholder the
 * recorder/binding session fills; `denied` edges become journey deny steps.
 * Systems with session policies come out as Cast session-policy groups —
 * Siebel's max-1 becomes an enforceable constraint, not tribal knowledge.
 *
 * Scope, loudly enforced: one linear login chain (no branching — split
 * decision paths into separate graphs/journeys), no cycles, every session
 * needs an actor lane.
 */

import type { Journey, JourneyStep } from '../journeys/schema';
import { validateJourney } from '../journeys/schema';
import type { SessionPolicies, SessionPolicyGroup } from '../fixtures/cast';
import type { AuthMethod, ProcessGraph, PNode } from './schema';
import { validateGraph } from './schema';
import { dataflowHealth, runOrder, type ChainProblem } from './compose';

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
  /** `requires` prerequisite relations (→ Playwright project deps later). */
  requires: { from: string; to: string }[];
  /** Step index → source edge id — the merge-back mapping. */
  stepEdgeIds: (string | null)[];
  warnings: string[];
}

/** The walker's three refusals in THIS exporter's words (compose.ts words the
 *  same problems for the planner's check panel). */
function chainErrorText(p: ChainProblem): string {
  switch (p.kind) {
    case 'no_start': return "a graph needs a 'start' node to anchor the login_as chain";
    case 'branch': return `'${p.at}' has ${p.count} outgoing login_as edges — one linear session chain per graph`;
    case 'cycle': return `login_as cycle at '${p.at}'`;
  }
}

/**
 * The export: `touches`/`asserts` are relations, not steps; `requires` comes
 * back as prerequisite metadata. The WALK itself is `runOrder()` in
 * compose.ts — one implementation, so the planner's run-order preview and
 * this journey cannot drift apart.
 */
export function toJourney(graph: ProcessGraph, opts: ToJourneyOptions = {}): ToJourneyResult {
  const gv = validateGraph(graph, { personaAuth: opts.personaAuth });
  if (!gv.ok) throw new Error(`graph invalid:\n - ${gv.errors.join('\n - ')}`);

  const warnings: string[] = [];
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // The walk (compose.runOrder): chain sessions in login order, each
  // session's does/asserts/denied edges in declaration order.
  const order = runOrder(graph);
  if (order.cause) throw new Error(chainErrorText(order.cause));
  if (order.chain.length === 0) throw new Error('no login_as chain found — connect start to the first session');
  // Every session on the chain needs a lane, whether or not it schedules a step.
  for (const sessId of order.chain) {
    if (!nodeById.get(sessId)?.actor) throw new Error(`session '${sessId}' has no actor — every session needs a role/user`);
  }
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

  // Dataflow: who defines each data node decides what a consumer receives.
  const dataflow = dataflowHealth(graph);
  for (const err of dataflow.errors) warnings.push(`dataflow: ${err}`);
  for (const w of dataflow.warnings) warnings.push(`dataflow: ${w}`);

  const steps: JourneyStep[] = [];
  const unboundSteps: string[] = [];
  const stepEdgeIds: (string | null)[] = [];
  for (const step of order.steps) {
    const e = edgeById.get(step.edgeId);
    // Defensive: runOrder builds every step FROM an edge of this graph.
    if (!e) continue;
    const target = nodeById.get(e.to);
    if (step.kind === 'does') {
      // runOrder already named it: the catalog, or the plan.<edge> placeholder.
      const doName = step.name;
      if (!e.data?.catalog) unboundSteps.push(doName);
      const withArgs: Record<string, unknown> = {};
      if (target?.type === 'data') {
        // The PORT decides what the step receives (STUDY-DATA-FLOW.md §3.3):
        // consumes/updates → the runtime handle (bind map, or the default
        // { record: '{ref:<ref>.id}' }); produces → the step publishes the
        // record via ctx.produce(<ref>) and gets the handle name to use;
        // no port at all → the label, as a business key.
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
        actor: step.actor,
        do: doName,
        ...(Object.keys(withArgs).length ? { with: withArgs } : {}),
        ...(oracles.length ? { expect: { expects: oracles } } : {}),
      });
      stepEdgeIds.push(e.id);
    } else if (step.kind === 'asserts') {
      // assert.* steps run on their oracles alone — the runner evaluates
      // them centrally, no catalog entry required. (runOrder only schedules
      // asserts that land on a checkpoint.)
      const oracles = expectationsFor(target, e.id, undefined, true);
      steps.push({
        actor: step.actor,
        do: step.name,
        ...(oracles.length ? { expect: { expects: oracles } } : {}),
      });
      stepEdgeIds.push(e.id);
    } else {
      steps.push({
        deny: {
          actor: step.actor,
          // The validator requires data.capability on every denied edge, and
          // this graph validated above — runOrder read it from the same place.
          capability: step.name,
          ...(e.data?.recordRef !== undefined ? { target: e.data.recordRef } : {}),
        },
      });
      stepEdgeIds.push(e.id);
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

/**
 * The persona MATRIX: one variant per way of binding the aliases that carry
 * `alternatives`. The first variant is the graph's own `actors` (the
 * default); then each alternative in turn; several aliases with
 * alternatives combine as a cartesian product (capped — a matrix bigger
 * than 24 runs is a modelling smell, not a test plan).
 */
export interface GraphVariant {
  /** Stable, lower_snake_case: the personas that differ from the default, joined by '__'; 'default' for the base binding. */
  id: string;
  /** Human label: "client_associate → client_lead". */
  label: string;
  actors: Record<string, string>;
}

export const MAX_VARIANTS = 24;

export function expandVariants(graph: ProcessGraph): GraphVariant[] {
  const alts = Object.entries(graph.alternatives ?? {}).filter(([, list]) => list.length);
  if (!alts.length) return [{ id: 'default', label: 'default', actors: { ...graph.actors } }];
  // Per alias: [default, ...alternatives].
  const axes = alts.map(([alias, list]) => ({ alias, personas: [graph.actors[alias]!, ...list] }));
  let combos: { alias: string; persona: string }[][] = [[]];
  for (const axis of axes) {
    combos = combos.flatMap((prefix) => axis.personas.map((persona) => [...prefix, { alias: axis.alias, persona }]));
  }
  if (combos.length > MAX_VARIANTS) {
    throw new Error(`persona matrix has ${combos.length} variants (max ${MAX_VARIANTS}) — split the graph or trim alternatives`);
  }
  return combos.map((combo) => {
    const actors = { ...graph.actors };
    const changed: string[] = [];
    for (const { alias, persona } of combo) {
      actors[alias] = persona;
      if (persona !== graph.actors[alias]) changed.push(`${alias} → ${persona}`);
    }
    const id = changed.length ? changed.map((c) => c.split(' → ')[1]!).join('__') : 'default';
    return { id, label: changed.length ? changed.join(', ') : 'default', actors };
  });
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
