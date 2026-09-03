/**
 * PG-0 — process-graph schema (docs/DESIGN-PROCESS-GRAPH.md §3.2).
 *
 * A process is a typed property graph: systems (with session policies — Siebel
 * gets maxConcurrent 1), actors (aliases onto personas.json), nodes carrying
 * the four planning data points (account env-name, app URL, steps placeholder,
 * snapshot slot) plus timing, and typed relation edges (login_as / does /
 * denied / asserts / touches / handoff / requires / next) that carry captured
 * timing, data ports and shared-record joints.
 *
 * `process-graph/2` is the ONLY authoring form. v1 documents still open —
 * upgrade.ts converts them at the load door (resolve.ts, the planner) — but
 * nothing downstream of that door knows the v1 vocabulary.
 *
 * Discipline mirrors personas.json: env-var NAMES only (inline secrets are
 * rejected), lower_snake_case ids, dependency-free validation reporting every
 * problem at once. This file has NO imports — the planner build transpiles it
 * standalone so the web view validates with the SAME code.
 */

export type SystemKind = 'salesforce' | 'siebel' | 'web' | 'api' | 'other';

/** How a session is acquired. Structurally mirrors personas/schema.ts's
 *  AuthMethod — declared again rather than imported because this file must
 *  transpile standalone for the planner (see the header note). The two are
 *  kept in step by a unit test. */
export type AuthMethod = 'frontdoor' | 'singleaccess' | 'ui';

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

export type DataOrigin = 'step' | 'seed' | 'external';

/**
 * The PORT on an edge that touches a data node (STUDY-DATA-FLOW.md §3):
 * produces = this action DEFINES the record (creates it; the step publishes
 * its id), consumes = this action READS it (needs the id: open, verify),
 * updates = reads AND changes it. Dataflow validity — every consume has a
 * definition earlier in the walk — is checked by dataflowHealth() in graph/compose.ts.
 */
export type DataIo = 'produces' | 'consumes' | 'updates';

export type NodeType =
  | 'start' | 'checkpoint' | 'end'
  // State nodes — STUDY-TEST-GRAPH-REPRESENTATION.md:
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
  /** State oracles — what must be TRUE here (pass/fail per expectation). */
  expects?: Expectation[];
  /** db nodes only: can tests query it? Many DBs can't be reached — leave
   *  false and verify through the app API or the logger instead. */
  queryable?: boolean;
  /** logger nodes only: can tests search it for traffic? */
  searchable?: boolean;
  /** api nodes only: the endpoint this node names (e.g. create_customer_v2). */
  endpoint?: { method?: string; path?: string };
  /**
   * data nodes only (STUDY-DATA-FLOW.md §3.1) — the node is a runtime
   * VARIABLE, not just a picture. `ref` is the handle steps resolve with
   * `{ref:<ref>.id}` (defaults to the node id); `sobject` the SObject the
   * record is; `origin` who is expected to DEFINE it: a `produces` edge in
   * this graph ('step', default), the journey seed block ('seed'), or a
   * pre-existing record the run finds rather than creates ('external').
   */
  ref?: string;
  sobject?: string;
  origin?: DataOrigin;
  notes?: string;
  /** Authored canvas position; captured graphs are auto-laid-out instead. */
  pos?: { x: number; y: number };
}

export type EdgeType =
  | 'next' | 'handoff'
  // Relation edges — actions/relations live ON the edge:
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
    /** Required on denied edges: the capability being refused. */
    capability?: string;
    /** `does` edges: the step-catalog action this relation performs. */
    catalog?: string;
    /** `login_as` edges: how the session is acquired. */
    auth?: AuthMethod;
    /** Edges landing on a data node: the port direction (see DataIo). */
    io?: DataIo;
    /**
     * Port map for consumes/updates: step arg name → placeholder, e.g.
     * { id: '{ref:customer.id}' }. Omitted = the walker's default,
     * { record: '{ref:<ref>.id}' }.
     */
    bind?: Record<string, string>;
    /** Machine-guessed port (ado:import / capture) — confirm once to clear. */
    ioDraft?: boolean;
  };
}

export interface ProcessGraph {
  schema: 'process-graph/2';
  id: string;
  title?: string;
  systems: Record<string, SystemDef>;
  actors: Record<string, string>;
  nodes: PNode[];
  edges: PEdge[];
  /** Provenance of graphs composed INTO this one (compose.ts) — a copy-merge
   *  record, newest last. Purely informational; enables staleness checks. */
  composedFrom?: { ref: string; graphId: string; at: string }[];
  /**
   * Persona MATRIX (owner 2026-09-02: ADO "Personas who can perform this
   * action: A, B, C"): alias → the OTHER persona ids that may play it. The
   * flow is run once per persona (the default in `actors` first, then each
   * alternative) — see expandVariants(). Every id must exist in
   * personas.json; the alias must exist in `actors`.
   */
  alternatives?: Record<string, string[]>;
  /**
   * Suite labels (`sod`, `smoke`, `regression`…): lower_snake_case, no
   * duplicates. The schema deliberately fixes no vocabulary — `suites.json`
   * decides which tags mean anything, and `selectGraphs('tag:sod')` is the
   * only reader (src/suites.ts).
   */
  tags?: string[];
}

export interface GraphValidation {
  ok: boolean;
  errors: string[];
}

const ID_RE = /^[a-z][a-z0-9_]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
export const NODE_TYPES: NodeType[] = ['start', 'checkpoint', 'end', 'session', 'screen', 'data', 'db', 'logger', 'api'];
export const EDGE_TYPES: EdgeType[] = ['next', 'handoff', 'login_as', 'does', 'requires', 'touches', 'asserts', 'denied'];
export const SYSTEM_KINDS: SystemKind[] = ['salesforce', 'siebel', 'web', 'api', 'other'];
export const STATUSES: PlanStatus[] = ['planned', 'captured'];
export const DATA_IOS: DataIo[] = ['produces', 'consumes', 'updates'];
export const DATA_ORIGINS: DataOrigin[] = ['step', 'seed', 'external'];
export const EXPECTATION_KINDS: ExpectationKind[] = [
  'ui.visible', 'ui.text', 'ui.toast', 'ui.url', 'api.record_exists', 'api.field_equals',
  'db.query', 'log.traffic',
];
/** Backend oracle kinds evaluate server-side and may poll (async settles). */
const BACKEND_KIND_RE = /^(api|db|log)\./;

/** Auth method each known persona uses, from personas.json. Supplied by
 *  callers that can read the roster (the walker, the planner build); when
 *  absent, the login_as agreement check is simply not run. */
export interface ValidateGraphOptions {
  personaAuth?: Record<string, AuthMethod | undefined> | undefined;
}

export function validateGraph(doc: unknown, opts: ValidateGraphOptions = {}): GraphValidation {
  const errors: string[] = [];
  const g = doc as Partial<ProcessGraph> | null;
  if (!g || typeof g !== 'object') return { ok: false, errors: ['graph must be an object'] };

  // v2 only: a v1 document is upgraded at the load door (upgrade.ts) and
  // never reaches the validator still wearing its old tag.
  if (g.schema !== 'process-graph/2') errors.push("schema: must be 'process-graph/2'");
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

  for (const [alias, list] of Object.entries(g.alternatives ?? {})) {
    if (!(alias in actors)) errors.push(`alternatives.${alias}: alias is not in actors`);
    if (!Array.isArray(list) || !list.length) errors.push(`alternatives.${alias}: non-empty array of persona ids required`);
    else {
      for (const [i, id] of list.entries()) {
        if (typeof id !== 'string' || !id) errors.push(`alternatives.${alias}[${i}]: persona id must be a non-empty string`);
        else if (id === actors[alias]) errors.push(`alternatives.${alias}: '${id}' is already the default persona for this alias`);
        else if (list.indexOf(id) !== i) errors.push(`alternatives.${alias}: '${id}' listed twice`);
      }
    }
  }
  const tags = g.tags;
  if (tags !== undefined) {
    if (!Array.isArray(tags)) errors.push('tags: array of lower_snake_case labels required');
    else {
      for (const [i, t] of tags.entries()) {
        if (typeof t !== 'string' || !ID_RE.test(t)) errors.push(`tags[${i}]: lower_snake_case label required`);
        else if (tags.indexOf(t) !== i) errors.push(`tags: '${t}' listed twice`);
      }
    }
  }

  for (const [i, c] of (g.composedFrom ?? []).entries()) {
    if (!c || typeof c.ref !== 'string' || !c.ref || typeof c.graphId !== 'string' || !c.graphId || typeof c.at !== 'string' || !c.at) {
      errors.push(`composedFrom[${i}]: needs { ref, graphId, at } strings`);
    }
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
    for (const field of ['ref', 'sobject', 'origin'] as const) {
      if (n?.[field] !== undefined && n.type !== 'data') {
        errors.push(`${at}.${field}: only data nodes carry a runtime binding`);
      }
    }
    if (n?.ref !== undefined && !ID_RE.test(n.ref)) {
      errors.push(`${at}.ref: lower_snake_case handle required (steps resolve it as {ref:${n.ref}.id})`);
    }
    if (n?.sobject !== undefined && (typeof n.sobject !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/.test(n.sobject))) {
      errors.push(`${at}.sobject: SObject API name required (e.g. Account, Custom__c)`);
    }
    if (n?.origin !== undefined && !DATA_ORIGINS.includes(n.origin)) {
      errors.push(`${at}.origin: one of ${DATA_ORIGINS.join('|')}`);
    }
  }

  // Two data nodes must not share a runtime handle — {ref:x.id} would be
  // ambiguous at run time.
  const refOwner = new Map<string, string>();
  for (const n of g.nodes ?? []) {
    if (n?.type !== 'data' || !n.id) continue;
    const ref = n.ref ?? n.id;
    const other = refOwner.get(ref);
    if (other) errors.push(`nodes.${n.id}.ref: handle '${ref}' already used by data node '${other}'`);
    else refOwner.set(ref, n.id);
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
    if (e?.type === 'denied' && !e.data?.capability) {
      errors.push(`${at}: denied edges require data.capability (what is being refused)`);
    }
    if (e?.type === 'login_as') {
      const target = (g.nodes ?? []).find((n) => n.id === e.to);
      if (target && target.type !== 'session') {
        errors.push(`${at}: login_as must land on a session node (got '${target.type}')`);
      }
      // The edge DECLARES how the session is acquired; personas.json DECIDES.
      // Cast reads the persona, so a disagreement makes the graph document a
      // login that will never happen. Caught here rather than at run time.
      const declared = e.data?.auth;
      if (declared && opts.personaAuth && target?.actor) {
        const personaId = actors[target.actor];
        const actual = personaId ? opts.personaAuth[personaId] : undefined;
        if (actual && actual !== declared) {
          errors.push(
            `${at}.data.auth: declares '${declared}' but persona '${personaId}' authenticates by '${actual}' ` +
              `(personas.json decides — change the edge, or change the persona)`,
          );
        }
      }
    }
    if (e?.type === 'does' && !e.data?.catalog && !e.label) {
      errors.push(`${at}: does edges need data.catalog (the step) or at least a label placeholder`);
    }
    if (e?.data?.io !== undefined) {
      if (!DATA_IOS.includes(e.data.io)) errors.push(`${at}.data.io: one of ${DATA_IOS.join('|')}`);
      const target = (g.nodes ?? []).find((n) => n?.id === e.to);
      if (target && target.type !== 'data') {
        errors.push(`${at}.data.io: a port only makes sense on an edge landing on a data node (got '${target.type}')`);
      }
    }
    if (e?.data?.ioDraft !== undefined && typeof e.data.ioDraft !== 'boolean') errors.push(`${at}.data.ioDraft: boolean`);
    if (e?.data?.ioDraft !== undefined && e.data.io === undefined) errors.push(`${at}.data.ioDraft: needs data.io (what is drafted?)`);
    if (e?.data?.bind !== undefined) {
      if (e.data.io === undefined || e.data.io === 'produces') {
        errors.push(`${at}.data.bind: only consumes/updates edges bind args (produces publishes, it does not read)`);
      } else if (!e.data.bind || typeof e.data.bind !== 'object' || Array.isArray(e.data.bind)) {
        errors.push(`${at}.data.bind: object of argName → '{ref:<handle>.<prop>}'`);
      } else {
        for (const [arg, ph] of Object.entries(e.data.bind)) {
          if (!ID_RE.test(arg)) errors.push(`${at}.data.bind.${arg}: arg name must be lower_snake_case`);
          if (typeof ph !== 'string' || !/\{ref:[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_.]+)?\}/.test(ph)) {
            errors.push(`${at}.data.bind.${arg}: must contain a {ref:<handle>.<prop>} placeholder`);
          }
        }
      }
    }
    if (e?.data?.deltaMs !== undefined && e.data.deltaMs < 0) errors.push(`${at}.data.deltaMs: must be >= 0`);
    if (e?.data?.frequency !== undefined && !(e.data.frequency >= 1)) errors.push(`${at}.data.frequency: must be >= 1`);
  }

  return { ok: errors.length === 0, errors };
}
