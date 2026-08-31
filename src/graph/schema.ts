/**
 * PG-0 — process-graph schema (docs/DESIGN-PROCESS-GRAPH.md §3.2).
 *
 * A process is a typed property graph: systems (with session policies — Siebel
 * gets maxConcurrent 1), actors (aliases onto personas.json), nodes carrying
 * the four planning data points (account env-name, app URL, steps placeholder,
 * snapshot slot) plus timing, and typed edges (next / navigates / handoff /
 * deny) that carry captured timing and shared-record joints.
 *
 * Discipline mirrors personas.json: env-var NAMES only (inline secrets are
 * rejected), lower_snake_case ids, dependency-free validation reporting every
 * problem at once. This file has NO imports — the planner build transpiles it
 * standalone so the web view validates with the SAME code.
 */

export type SystemKind = 'salesforce' | 'siebel' | 'web' | 'api' | 'other';

export interface SystemDef {
  label: string;
  kind: SystemKind;
  /** Env-var NAME holding the app URL (never a literal URL with credentials). */
  urlEnv?: string;
  /** Siebel-style limits: how many live sessions this system tolerates. */
  sessionPolicy?: { maxConcurrent: number };
}

export type ExpectationKind =
  | 'ui.visible' | 'ui.text' | 'ui.toast' | 'ui.url'
  | 'api.record_exists' | 'api.field_equals'
  // Infra evidence sources (S7): target = the db/logger NODE ID.
  | 'db.query'      // run value (a query/where) against a QUERYABLE db node
  | 'log.traffic';  // search a logger node for value (e.g. an endpoint name)

/** A state oracle: what must be true in this node's state (DESIGN-EXPECTATIONS.md). */
export interface Expectation {
  id: string;
  kind: ExpectationKind;
  /** ui.*: role/label/text target · api.*: SObject name. */
  target?: string;
  /** Expected text/url; api.field_equals: "Field=Value". */
  value?: string;
  /** Only checked when this edge (id or its catalog) lands here; omitted = every landing. */
  after?: string;
  /**
   * Override the 10s oracle default — REQUIRED thinking for api.* on async
   * integrations (SF→Siebel replication): the oracle polls until timeoutMs.
   */
  timeoutMs?: number;
  /** api.* only: poll interval while waiting (default 1000ms, min 100). */
  pollMs?: number;
  /** Machine-guessed (capture-first / ado:import) — confirm once to clear. */
  draft?: boolean;
  note?: string;
  lastResult?: { status: 'pass' | 'fail'; at: string; runId?: string; message?: string };
}

export type NodeType =
  | 'start' | 'action' | 'decision' | 'checkpoint' | 'snapshot' | 'end'
  // process-graph/2 (state nodes — STUDY-TEST-GRAPH-REPRESENTATION.md):
  | 'session' | 'screen' | 'data'
  // Infra nodes (S7): evidence sources + integration hops, not steps.
  | 'db' | 'logger' | 'api';
export type PlanStatus = 'planned' | 'captured';

export interface PNode {
  id: string;
  type: NodeType;
  label: string;
  /** Lane coordinates. */
  system?: string;
  actor?: string;
  /** The four data points. */
  account?: { usernameEnv: string };
  url?: string;
  steps?: { status: PlanStatus; journeyId?: string; stepIndexes?: number[] };
  snapshot?: { status: PlanStatus; ref?: string; capturedAt?: string };
  timing?: { plannedMs?: number; capturedMeanMs?: number; capturedP95Ms?: number };
  /** Step-catalog binding once known (export uses it; planner form offers it). */
  catalog?: string;
  /** State oracles — what must be TRUE here (pass/fail per expectation). */
  expects?: Expectation[];
  /** db nodes only: can tests query it? Many DBs can't be reached — leave
   *  false and verify through the app API or the logger instead. */
  queryable?: boolean;
  /** logger nodes only: can tests search it for traffic? */
  searchable?: boolean;
  /** api nodes only: the endpoint this node names (e.g. create_customer_v2). */
  endpoint?: { method?: string; path?: string };
  notes?: string;
  /** Authored canvas position; captured graphs are auto-laid-out instead. */
  pos?: { x: number; y: number };
}

export type EdgeType =
  | 'next' | 'navigates' | 'handoff' | 'deny'
  // process-graph/2 (relation edges — actions/relations live ON the edge):
  | 'login_as' | 'does' | 'requires' | 'touches' | 'asserts' | 'denied';

export interface PEdge {
  id: string;
  from: string;
  to: string;
  type: EdgeType;
  label?: string;
  data?: {
    deltaMs?: number;
    recordRef?: string;
    frequency?: number;
    meanMs?: number;
    /** Required on deny/denied edges: the capability being refused. */
    capability?: string;
    /** v2 `does` edges: the step-catalog action this relation performs. */
    catalog?: string;
    /** v2 `login_as` edges: how the session is acquired. */
    auth?: 'frontdoor' | 'singleaccess' | 'ui';
  };
}

export interface ProcessGraph {
  schema: 'process-graph/1' | 'process-graph/2';
  id: string;
  title?: string;
  systems: Record<string, SystemDef>;
  actors: Record<string, string>;
  nodes: PNode[];
  edges: PEdge[];
}

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^[a-z][a-z0-9_]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const NODE_TYPES: NodeType[] = ['start', 'action', 'decision', 'checkpoint', 'snapshot', 'end', 'session', 'screen', 'data', 'db', 'logger', 'api'];
const EDGE_TYPES: EdgeType[] = ['next', 'navigates', 'handoff', 'deny', 'login_as', 'does', 'requires', 'touches', 'asserts', 'denied'];
const SYSTEM_KINDS: SystemKind[] = ['salesforce', 'siebel', 'web', 'api', 'other'];
const STATUSES: PlanStatus[] = ['planned', 'captured'];
const EXPECTATION_KINDS: ExpectationKind[] = [
  'ui.visible', 'ui.text', 'ui.toast', 'ui.url', 'api.record_exists', 'api.field_equals',
  'db.query', 'log.traffic',
];
/** Backend oracle kinds evaluate server-side and may poll (async settles). */
const BACKEND_KIND_RE = /^(api|db|log)\./;

export function validateGraph(doc: unknown): GraphValidation {
  const errors: string[] = [];
  const g = doc as Partial<ProcessGraph> | null;
  if (!g || typeof g !== 'object') return { ok: false, errors: ['graph must be an object'] };

  if (g.schema !== 'process-graph/1' && g.schema !== 'process-graph/2') {
    errors.push("schema: must be 'process-graph/1' or 'process-graph/2'");
  }
  if (!g.id || !ID_RE.test(g.id)) errors.push('id: lower_snake_case required');

  const systems = g.systems ?? {};
  for (const [sid, s] of Object.entries(systems)) {
    const at = `systems.${sid}`;
    if (!ID_RE.test(sid)) errors.push(`${at}: key must be lower_snake_case`);
    if (!s || typeof s !== 'object') { errors.push(`${at}: must be an object`); continue; }
    if (!s.label) errors.push(`${at}.label: required`);
    if (!SYSTEM_KINDS.includes(s.kind)) errors.push(`${at}.kind: one of ${SYSTEM_KINDS.join('|')}`);
    if (s.urlEnv !== undefined && !ENV_NAME_RE.test(s.urlEnv)) {
      errors.push(`${at}.urlEnv: must be an ENV VAR NAME (looks like an inline value)`);
    }
    const max = s.sessionPolicy?.maxConcurrent;
    if (s.sessionPolicy !== undefined && (!Number.isInteger(max) || (max!) < 1)) {
      errors.push(`${at}.sessionPolicy.maxConcurrent: integer >= 1 required`);
    }
  }

  const actors = g.actors ?? {};
  for (const [alias, persona] of Object.entries(actors)) {
    if (!ID_RE.test(alias)) errors.push(`actors.${alias}: alias must be lower_snake_case`);
    if (typeof persona !== 'string' || !persona) errors.push(`actors.${alias}: personaId must be a non-empty string`);
  }

  const nodeIds = new Set<string>();
  for (const n of g.nodes ?? []) {
    const at = `nodes.${n?.id ?? '?'}`;
    if (!n?.id || !ID_RE.test(n.id)) errors.push(`${at}: id lower_snake_case required`);
    else if (nodeIds.has(n.id)) errors.push(`${at}: duplicate node id`);
    else nodeIds.add(n.id);
    if (!NODE_TYPES.includes(n?.type)) errors.push(`${at}.type: one of ${NODE_TYPES.join('|')}`);
    if (!n?.label && n?.type !== 'start' && n?.type !== 'end') errors.push(`${at}.label: required`);
    if (n?.type === 'session' && !n.system) errors.push(`${at}: session nodes require a system (the lane they log into)`);
    if (n?.system !== undefined && !systems[n.system]) errors.push(`${at}.system: '${n.system}' not in systems`);
    if (n?.actor !== undefined && !actors[n.actor]) errors.push(`${at}.actor: '${n.actor}' not in actors`);
    if (n?.account !== undefined) {
      if (!n.account.usernameEnv || !ENV_NAME_RE.test(n.account.usernameEnv)) {
        errors.push(`${at}.account.usernameEnv: must be an ENV VAR NAME (no inline credentials)`);
      }
    }
    if (n?.url !== undefined && /:\/\/[^/]*:[^/@]*@/.test(n.url)) {
      errors.push(`${at}.url: embeds credentials — never store user:pass in URLs`);
    }
    if (n?.steps !== undefined && !STATUSES.includes(n.steps.status)) {
      errors.push(`${at}.steps.status: one of ${STATUSES.join('|')}`);
    }
    if (n?.snapshot !== undefined && !STATUSES.includes(n.snapshot.status)) {
      errors.push(`${at}.snapshot.status: one of ${STATUSES.join('|')}`);
    }
    if (n?.timing?.plannedMs !== undefined && !(n.timing.plannedMs > 0)) {
      errors.push(`${at}.timing.plannedMs: must be > 0`);
    }
    const expectIds = new Set<string>();
    for (const x of n?.expects ?? []) {
      const xat = `${at}.expects.${x?.id ?? '?'}`;
      if (!x?.id || !ID_RE.test(x.id)) errors.push(`${xat}: id lower_snake_case required`);
      else if (expectIds.has(x.id)) errors.push(`${xat}: duplicate expectation id on this node`);
      else expectIds.add(x.id);
      if (!EXPECTATION_KINDS.includes(x?.kind)) {
        errors.push(`${xat}.kind: one of ${EXPECTATION_KINDS.join('|')}`);
      }
      if ((x?.kind === 'api.record_exists' || x?.kind === 'api.field_equals') && !x.target) {
        errors.push(`${xat}: api.* expectations need target (the SObject)`);
      }
      if (x?.kind === 'ui.visible' && !x.target) errors.push(`${xat}: ui.visible needs target`);
      if ((x?.kind === 'ui.text' || x?.kind === 'ui.toast' || x?.kind === 'ui.url' || x?.kind === 'api.field_equals') && !x.value) {
        errors.push(`${xat}: ${x.kind} needs value (the expected text/url/Field=Value)`);
      }
      if (x?.lastResult && x.lastResult.status !== 'pass' && x.lastResult.status !== 'fail') {
        errors.push(`${xat}.lastResult.status: pass|fail`);
      }
      if (x?.timeoutMs !== undefined && (!Number.isInteger(x.timeoutMs) || x.timeoutMs < 100 || x.timeoutMs > 600_000)) {
        errors.push(`${xat}.timeoutMs: integer 100..600000`);
      }
      if (x?.pollMs !== undefined) {
        if (!Number.isInteger(x.pollMs) || x.pollMs < 100) errors.push(`${xat}.pollMs: integer ≥ 100`);
        else if (x.timeoutMs !== undefined && x.pollMs >= x.timeoutMs) errors.push(`${xat}.pollMs: must be < timeoutMs`);
        if (typeof x.kind === 'string' && !BACKEND_KIND_RE.test(x.kind)) errors.push(`${xat}.pollMs: only backend oracles (api./db./log.) poll`);
      }
      if (x?.draft !== undefined && typeof x.draft !== 'boolean') errors.push(`${xat}.draft: boolean`);
      if ((x?.kind === 'db.query' || x?.kind === 'log.traffic') && !x.target) {
        errors.push(`${xat}: ${x.kind} needs target (the ${x.kind === 'db.query' ? 'db' : 'logger'} node id)`);
      }
      if ((x?.kind === 'db.query' || x?.kind === 'log.traffic') && !x.value) {
        errors.push(`${xat}: ${x.kind} needs value (${x.kind === 'db.query' ? 'the query/where clause' : 'what to search for, e.g. the endpoint name'})`);
      }
    }
    if (n?.type === 'db' && n.queryable !== undefined && typeof n.queryable !== 'boolean') {
      errors.push(`${at}.queryable: boolean`);
    }
    if (n?.type === 'logger' && n.searchable !== undefined && typeof n.searchable !== 'boolean') {
      errors.push(`${at}.searchable: boolean`);
    }
    if (n?.endpoint !== undefined && n.type !== 'api') {
      errors.push(`${at}.endpoint: only api nodes name endpoints`);
    }
  }

  // Infra cross-references (need the full node list, hence a second pass):
  // a db.query must point at a QUERYABLE db node; log.traffic at a logger.
  for (const n of g.nodes ?? []) {
    for (const x of n?.expects ?? []) {
      const xat = `nodes.${n?.id ?? '?'}.expects.${x?.id ?? '?'}`;
      if (x?.kind === 'db.query' && x.target) {
        const dbNode = (g.nodes ?? []).find((d) => d?.id === x.target);
        if (dbNode?.type !== 'db') {
          errors.push(`${xat}: target '${x.target}' is not a db node`);
        } else if (!dbNode.queryable) {
          errors.push(`${xat}: db '${x.target}' is not queryable — mark it queryable:true, or verify via the app API or a logger instead`);
        }
      }
      if (x?.kind === 'log.traffic' && x.target) {
        const logNode = (g.nodes ?? []).find((d) => d?.id === x.target);
        if (logNode?.type !== 'logger') {
          errors.push(`${xat}: target '${x.target}' is not a logger node`);
        } else if (logNode.searchable === false) {
          errors.push(`${xat}: logger '${x.target}' is marked not searchable — make it searchable or verify another way`);
        }
      }
    }
  }

  const edgeIds = new Set<string>();
  for (const e of g.edges ?? []) {
    const at = `edges.${e?.id ?? '?'}`;
    if (!e?.id || !ID_RE.test(e.id)) errors.push(`${at}: id lower_snake_case required`);
    else if (edgeIds.has(e.id)) errors.push(`${at}: duplicate edge id`);
    else edgeIds.add(e.id);
    if (!EDGE_TYPES.includes(e?.type)) errors.push(`${at}.type: one of ${EDGE_TYPES.join('|')}`);
    for (const end of ['from', 'to'] as const) {
      if (!e?.[end] || !nodeIds.has(e[end])) errors.push(`${at}.${end}: unknown node '${e?.[end]}'`);
    }
    if ((e?.type === 'deny' || e?.type === 'denied') && !e.data?.capability) {
      errors.push(`${at}: deny edges require data.capability (what is being refused)`);
    }
    if (e?.type === 'login_as') {
      const target = (g.nodes ?? []).find((n) => n.id === e.to);
      if (target && target.type !== 'session') {
        errors.push(`${at}: login_as must land on a session node (got '${target.type}')`);
      }
    }
    if (e?.type === 'does' && !e.data?.catalog && !e.label) {
      errors.push(`${at}: does edges need data.catalog (the step) or at least a label placeholder`);
    }
    if (e?.data?.deltaMs !== undefined && e.data.deltaMs < 0) errors.push(`${at}.data.deltaMs: must be >= 0`);
    if (e?.data?.frequency !== undefined && !(e.data.frequency >= 1)) errors.push(`${at}.data.frequency: must be >= 1`);
  }

  return { ok: errors.length === 0, errors };
}
