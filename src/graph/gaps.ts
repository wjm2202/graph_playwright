/**
 * S6 — /grillme's engine. Two pure halves:
 *
 *  computeGaps(graph)   — everything standing between a draft and a runnable,
 *                         meaningful test, each gap phrased as the QUESTION a
 *                         human can answer in one multiple-choice beat.
 *  applyAnswers(graph)  — the write-back ops those answers translate to.
 *
 * The interrogation loop (the skill / CLI) is a thin shell over these, so
 * the judgment stays testable without a conversation in the middle.
 */
import { validateGraph, type DataIo, type ProcessGraph } from './schema';
import { dataflowHealth } from './compose';

/**
 * A GAP is a question with a write-back op behind it: answering it changes
 * the graph. Sprint 4.4 trimmed the list from twelve to eight (review §3.1)
 * — three former kinds are now HINTS (advice, no op) and the two port
 * questions were always one question with and without a default.
 */
export type GapKind =
  | 'role_unbound'        // actor alias → persona not in personas.json
  | 'does_unbound'        // does edge without a catalog binding
  | 'not_captured'        // session has no captured steps yet
  | 'draft_oracle'        // machine-guessed expect awaiting confirmation
  | 'api_no_timeout'      // backend oracle on the 10s default (async risk)
  | 'no_session_policy'   // non-SF system without a session policy
  // Dataflow (STUDY-DATA-FLOW.md §3.5):
  | 'data_port'           // does edge onto a data node: no port, or a drafted one
  | 'data_unproduced';    // consumes/updates with no definition before it

/**
 * A HINT is advice the strip shows and nobody has to answer: there is no op
 * that "applies" it, and a graph full of hints still runs.
 */
export type HintKind =
  | 'session_no_url'      // session lacks a landing URL (pre-navigation)
  | 'no_oracles'          // data/checkpoint node with nothing to check
  | 'no_deny_coverage';   // multi-role graph with zero denied edges

interface Question<K> {
  kind: K;
  /** node id, edge id, alias, or system key the gap lives on. */
  at: string;
  /** The full question grillme asks (self-contained, names the element). */
  question: string;
  /** Concise imperative for grouped display (element named by the group). */
  short: string;
  options?: string[];
}

export type Gap = Question<GapKind>;
export type Hint = Question<HintKind>;

export interface GapReport {
  /** Open questions with a write-back op behind them. */
  gaps: Gap[];
  /** Advice — never blocking, no op. */
  hints: Hint[];
}

/** Every gap kind the engine can emit (kept in step with GapKind by the spec drift test). */
export const GAP_KINDS: GapKind[] = [
  'role_unbound', 'does_unbound', 'not_captured', 'draft_oracle',
  'api_no_timeout', 'no_session_policy', 'data_port', 'data_unproduced',
];
/** Every hint kind (no op — the strip's third counter). */
export const HINT_KINDS: HintKind[] = ['session_no_url', 'no_oracles', 'no_deny_coverage'];
/** Every write-back op (kept in step with AnswerOp by the spec drift test). */
export const ANSWER_OPS = [
  'bindRole', 'setCatalog', 'answerExpect', 'setOracleBudget', 'addDeny', 'setSessionPolicy',
  'setIo', 'setExternal',
] as const;

export interface GapOptions {
  /** persona ids that exist in personas.json (enables `role_unbound`). */
  knownPersonas?: string[];
  /**
   * System keys whose session policy is already settled ELSEWHERE in the
   * project (review §3.1: "a property of a system, answer it once per
   * project"). `sfpw grillme` fills this from the graph's sibling graphs;
   * with no project context the question stays per graph, as before.
   */
  settledSystems?: string[];
}

export function computeGaps(graph: ProcessGraph, opts: GapOptions = {}): GapReport {
  const gaps: Gap[] = [];
  const hints: Hint[] = [];
  const known = opts.knownPersonas;
  const settled = new Set(opts.settledSystems ?? []);

  for (const [alias, list] of Object.entries(graph.alternatives ?? {})) {
    for (const personaId of list) {
      if (known && !known.includes(personaId)) {
        gaps.push({
          kind: 'role_unbound', at: `${alias}:${personaId}`,
          question: `Role '${alias}' may also be played by '${personaId}' (persona matrix), which is not in personas.json. Which persona should that be?`,
          short: `alternative persona '${personaId}' is not in personas.json — bind a real one`,
          ...(known.length ? { options: known } : {}),
        });
      }
    }
  }
  for (const [alias, personaId] of Object.entries(graph.actors)) {
    if (known && !known.includes(personaId)) {
      gaps.push({
        kind: 'role_unbound', at: alias,
        question: `Role '${alias}' is bound to persona '${personaId}', which is not in personas.json. Which persona should play it?`,
        short: `persona '${personaId}' is not in personas.json — bind a real one`,
        ...(known.length ? { options: known } : {}),
      });
    }
  }

  for (const e of graph.edges) {
    if (e.type === 'does' && !e.data?.catalog) {
      gaps.push({
        kind: 'does_unbound', at: e.id,
        question: `Step '${e.label ?? e.id}' has no catalog binding — name it (convention: <noun>.<verb>) or capture it.`,
        short: 'no catalog binding — name it (<noun>.<verb>) or capture it',
      });
    }
  }

  // An async integration is what makes a polling budget a real question.
  const multiSystem = Object.keys(graph.systems).length > 1;

  for (const n of graph.nodes) {
    if (n.type === 'session') {
      if (n.steps?.status !== 'captured') {
        gaps.push({
          kind: 'not_captured', at: n.id,
          question: `Session '${n.label || n.id}' has no captured steps — record it (double-click the node in the planner for the command).`,
          short: 'no captured steps — double-click the node to copy the record command',
        });
      }
      if (!n.url) {
        hints.push({
          kind: 'session_no_url', at: n.id,
          question: `Session '${n.label || n.id}' has no landing URL — where should this role start? (Enables pre-navigation so captures skip login/nav.)`,
          short: 'no landing URL — set where this role starts (enables pre-navigation)',
        });
      }
    }
    if ((n.type === 'data' || n.type === 'checkpoint') && !(n.expects?.length)) {
      hints.push({
        kind: 'no_oracles', at: n.id,
        question: `'${n.label || n.id}' has nothing to check — what proves this state is right?`,
        short: 'nothing to check — add what proves this state is right',
        options: ['a toast message', 'text on the screen', 'the record exists (API)', 'a field value (API)'],
      });
    }
    for (const x of n.expects ?? []) {
      if (x.draft) {
        gaps.push({
          kind: 'draft_oracle', at: `${n.id}.${x.id}`,
          question: `Machine-guessed check on '${n.label || n.id}': ${x.kind} ${x.target ?? ''}${x.value ? ` = "${x.value}"` : ''} — keep it?`,
          short: `confirm draft check '${x.id}' (${x.kind}${x.target ? ` ${x.target}` : ''})`,
          options: ['keep (confirm)', 'edit it', 'remove it'],
        });
      }
      // Only ask where the 10s default is genuinely a risk (review §3.1):
      // a log/db search, or an api.* check in a graph that spans more than
      // one system (i.e. something crosses an async integration). A
      // single-system api.* check on the default is not a question.
      if (/^(api|db|log)\./.test(x.kind) && x.timeoutMs === undefined && (/^(db|log)\./.test(x.kind) || multiSystem)) {
        gaps.push({
          kind: 'api_no_timeout', at: `${n.id}.${x.id}`,
          question: `Backend check '${x.id}' (${x.kind}) uses the 10s default. Is '${n.label || n.id}' written synchronously, or via an async integration that needs a polling budget? (Log search almost always needs one.)`,
          short: `set a polling budget on check '${x.id}' (async integrations outlive the 10s default)`,
          options: ['synchronous (10s is fine)', 'async — 2 min budget', 'async — 5 min budget'],
        });
      }
    }
  }

  const actorCount = Object.keys(graph.actors).length;
  if (actorCount >= 2 && !graph.edges.some((e) => e.type === 'denied')) {
    hints.push({
      kind: 'no_deny_coverage', at: graph.id,
      question: `${actorCount} roles and no denied edges — is there an action some role must NOT be able to do? (That's a security test worth having.)`,
      short: `${actorCount} roles, zero denied edges — add a must-NOT case or confirm none exist`,
      options: ['yes — let me name one', 'no negative cases in this flow'],
    });
  }

  for (const [key, sys] of Object.entries(graph.systems)) {
    if (sys.kind !== 'salesforce' && sys.kind !== 'web' && !sys.sessionPolicy && !settled.has(key)) {
      gaps.push({
        kind: 'no_session_policy', at: key,
        question: `System '${sys.label}' (${sys.kind}) has no session policy — does it allow concurrent sessions? (Siebel classically allows ONE; we logout-to-comply.)`,
        short: 'no session policy — set how many concurrent sessions it allows',
        options: ['one session max (logout-to-comply)', 'concurrent sessions are fine'],
      });
    }
  }

  // ---- dataflow ------------------------------------------------------------
  const dataIds = new Set(graph.nodes.filter((n) => n.type === 'data').map((n) => n.id));
  const nodeLabel = (id: string) => { const l = graph.nodes.find((x) => x.id === id)?.label; return l === undefined || l === '' ? id : l; };
  for (const e of graph.edges) {
    if (e.type !== 'does' || !dataIds.has(e.to)) continue;
    const name = e.label ?? e.data?.catalog ?? e.id;
    // ONE question — "what is the port here?" — asked with a default when
    // the importer guessed one (`ioDraft`) and without when it could not.
    if (e.data?.io && e.data.ioDraft) {
      gaps.push({
        kind: 'data_port', at: e.id,
        question: `Machine-guessed: '${name}' ${e.data.io} the ${nodeLabel(e.to)} — keep it?`,
        short: `port '${e.data.io}' is a guess — confirm or change it`,
        options: [`keep: ${e.data.io}`, ...(['produces', 'consumes', 'updates'] as DataIo[]).filter((io) => io !== e.data!.io).map((io) => `change to: ${io}`)],
      });
    } else if (!e.data?.io) {
      gaps.push({
        kind: 'data_port', at: e.id,
        question: `'${name}' touches the ${nodeLabel(e.to)} — does it CREATE it, READ it, or UPDATE it? (This is how the record's id reaches later steps.)`,
        short: 'no port — say whether this step creates, reads, or updates the record',
        options: ['produces (creates it)', 'consumes (reads it)', 'updates (reads and changes it)'],
      });
    }
  }
  const df = dataflowHealth(graph);
  for (const err of df.errors) {
    const edgeId = /^edge (\S+) /.exec(err)?.[1] ?? graph.id;
    const dataId = graph.edges.find((e) => e.id === edgeId)?.to ?? '?';
    gaps.push({
      kind: 'data_unproduced', at: edgeId,
      question: `${err}. Where does the ${nodeLabel(dataId)} come from?`,
      short: 'used before anything defines it — created earlier, or already out there?',
      options: ['created earlier in this graph (wire a produces edge before it)', 'the record already exists — find it (external)'],
    });
  }

  return { gaps, hints };
}

// ---------- write-back ----------

export type AnswerOp =
  | { op: 'bindRole'; alias: string; personaId: string }
  | { op: 'setCatalog'; edge: string; name: string }
  /** keep: true = confirm the draft · false = remove the check. */
  | { op: 'answerExpect'; node: string; id: string; keep: boolean }
  | { op: 'setOracleBudget'; node: string; id: string; timeoutMs: number; pollMs?: number }
  | { op: 'addDeny'; from: string; to: string; capability: string }
  | { op: 'setSessionPolicy'; system: string; maxConcurrent: number }
  /** `io` omitted = confirm whatever port is already on the edge. */
  | { op: 'setIo'; edge: string; io?: DataIo }
  | { op: 'setExternal'; node: string; external: boolean };

export interface ApplyResult {
  graph: ProcessGraph;
  changes: string[];
}

/** Pure: returns a new painted graph; throws if an op misses or the result is invalid. */
export function applyAnswers(graph: ProcessGraph, ops: AnswerOp[]): ApplyResult {
  const g = JSON.parse(JSON.stringify(graph)) as ProcessGraph; // deep-copy of a validated graph
  const changes: string[] = [];
  const node = (id: string) => {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) throw new Error(`op targets unknown node '${id}'`);
    return n;
  };
  const expectOn = (nodeId: string, id: string) => {
    const x = node(nodeId).expects?.find((e) => e.id === id);
    if (!x) throw new Error(`op targets unknown expectation '${nodeId}.${id}'`);
    return x;
  };

  for (const op of ops) {
    switch (op.op) {
      case 'bindRole': {
        if (!(op.alias in g.actors)) throw new Error(`op targets unknown role '${op.alias}'`);
        g.actors[op.alias] = op.personaId;
        changes.push(`role ${op.alias} → ${op.personaId}`);
        break;
      }
      case 'setCatalog': {
        const e = g.edges.find((x) => x.id === op.edge);
        if (!e) throw new Error(`op targets unknown edge '${op.edge}'`);
        e.data = { ...e.data, catalog: op.name };
        changes.push(`${op.edge} catalog = ${op.name}`);
        break;
      }
      case 'answerExpect': {
        if (op.keep) {
          const x = expectOn(op.node, op.id);
          delete x.draft;
          if (x.note?.startsWith('draft from')) delete x.note;
          changes.push(`${op.node}.${op.id} confirmed`);
        } else {
          const n = node(op.node);
          const before = n.expects?.length ?? 0;
          n.expects = (n.expects ?? []).filter((e) => e.id !== op.id);
          if (n.expects.length === before) throw new Error(`op targets unknown expectation '${op.node}.${op.id}'`);
          if (!n.expects.length) delete n.expects;
          changes.push(`${op.node}.${op.id} removed`);
        }
        break;
      }
      case 'setOracleBudget': {
        const x = expectOn(op.node, op.id);
        x.timeoutMs = op.timeoutMs;
        if (op.pollMs !== undefined) x.pollMs = op.pollMs;
        changes.push(`${op.node}.${op.id} budget ${op.timeoutMs}ms${op.pollMs ? `/${op.pollMs}ms` : ''}`);
        break;
      }
      case 'addDeny': {
        node(op.from); node(op.to);
        const id = uniqueEdgeId(g, 'e_deny');
        g.edges.push({ id, from: op.from, to: op.to, type: 'denied', label: `must NOT: ${op.capability}`, data: { capability: op.capability } });
        changes.push(`denied edge ${id}: ${op.from} must not ${op.capability}`);
        break;
      }
      case 'setIo': {
        const e = g.edges.find((x) => x.id === op.edge);
        if (!e) throw new Error(`op targets unknown edge '${op.edge}'`);
        // No `io` = "the guess is right": confirm what is already there.
        if (op.io === undefined && !e.data?.io) throw new Error(`edge '${op.edge}' has no port to confirm`);
        e.data = { ...e.data, ...(op.io !== undefined ? { io: op.io } : {}) };
        delete e.data.ioDraft;
        changes.push(op.io === undefined ? `${op.edge} io ${e.data.io} confirmed` : `${op.edge} io = ${op.io}`);
        break;
      }
      case 'setExternal': {
        const n = node(op.node);
        if (n.type !== 'data') throw new Error(`op targets '${op.node}' which is not a data node`);
        if (op.external) n.external = true; else delete n.external;
        changes.push(`${op.node} external = ${op.external}`);
        break;
      }
      case 'setSessionPolicy': {
        const sys = g.systems[op.system];
        if (!sys) throw new Error(`op targets unknown system '${op.system}'`);
        sys.sessionPolicy = { maxConcurrent: op.maxConcurrent };
        changes.push(`${op.system} sessionPolicy maxConcurrent=${op.maxConcurrent}`);
        break;
      }
    }
  }

  const v = validateGraph(g);
  if (!v.ok) throw new Error(`answers produced an invalid graph:\n - ${v.errors.join('\n - ')}`);
  return { graph: g, changes };
}

function uniqueEdgeId(g: ProcessGraph, base: string): string {
  let n = 1;
  let id = `${base}_${n}`;
  const ids = new Set(g.edges.map((e) => e.id));
  while (ids.has(id)) id = `${base}_${++n}`;
  return id;
}
