/**
 * Graph composition — import one graph INTO another to extend a workflow
 * (DESIGN-PROJECTS.md: "by joining add_address to create_customer the test
 * covers more functionality").
 *
 * This is a COPY-MERGE, not a live reference: the sub-graph's nodes and
 * edges are copied in and stitched, and `composedFrom` records provenance
 * (ref + graph id + when) so staleness is detectable later. The result stays
 * a self-contained document the whole toolchain already understands —
 * walker, runner, planner, merge-back all unchanged.
 *
 * TWO MODES (owner decision 2026-09-01: "I add the connection in the editor"):
 *  - 'island' (DEFAULT): the sub arrives intact but DISCONNECTED — sessions
 *    never merge, the chain is not touched, edges to the sub's end are
 *    dropped (relink after wiring). Its internal login_as chain is kept, so
 *    wiring in = one login_as edge from a previous session, then
 *    unlink/relink end. chainHealth lists the stranded sessions until then.
 *  - 'splice' (opt-in via `after` or mode): auto-wire — SESSIONS MERGE when
 *    system+actor+account agree (the sub's steps append AFTER the host's for
 *    that session) and the sub-chain splices in after the chosen session
 *    with a return edge; edges to the sub's end re-aim at the host's end.
 * Both modes: other nodes keep their ids and MERGE on same id+type (data
 * nodes union their checks, duplicates collapse, clashing check ids get a
 * prefix); a same-id/different-type clash imports under `<sub_id>_<id>`;
 * actor aliases must agree (same alias → same persona) and systems must
 * agree (same key → same definition) — anything else errors, never a silent
 * rebind. Rename in the sub first.
 *
 * NO imports beyond ./schema — the planner build inlines this file so the
 * browser insert does exactly what the CLI does.
 */

import { validateGraph, type PEdge, type PNode, type ProcessGraph } from './schema';

export interface ComposeOptions {
  /**
   * 'island' (default): the sub lands INTACT BUT DISCONNECTED — no session
   * merging, no chain splice, edges to the sub's end dropped. The human wires
   * the seam in the editor; chain health lists the stranded sessions until
   * they do. 'splice' (implied by `after`): auto-wire — sessions merge on
   * system+actor+account and the sub-chain splices into the host chain.
   */
  mode?: 'island' | 'splice';
  /** Host session id the sub-chain splices AFTER (implies mode 'splice';
   *  default splice point: last in chain). */
  after?: string;
  /** Provenance ref recorded in composedFrom (default: the sub's id). */
  ref?: string;
  /** ISO timestamp for the provenance stamp (injectable for tests). */
  now?: string;
}

export interface ComposeResult {
  graph: ProcessGraph;
  summary: string[];
}

/** The login_as chain from start: [sessionId…]; throws on branch/cycle. */
export function loginChain(g: ProcessGraph, label: string): string[] {
  const out = new Map<string, string[]>();
  for (const e of g.edges) {
    if (e.type !== 'login_as') continue;
    if (!out.has(e.from)) out.set(e.from, []);
    out.get(e.from)!.push(e.to);
  }
  for (const [from, tos] of out) {
    if (tos.length > 1) throw new Error(`${label}: '${from}' has ${tos.length} outgoing login_as edges — one linear chain required`);
  }
  const start = g.nodes.find((n) => n.type === 'start');
  if (!start) throw new Error(`${label}: no start node`);
  const chain: string[] = [];
  const seen = new Set<string>();
  let cursor = out.get(start.id)?.[0];
  while (cursor) {
    if (seen.has(cursor)) throw new Error(`${label}: login_as cycle at '${cursor}'`);
    seen.add(cursor);
    chain.push(cursor);
    cursor = out.get(cursor)?.[0];
  }
  return chain;
}

/**
 * Chain health — the check the schema validator deliberately does NOT do
 * (a mid-edit draft must stay saveable): is the login chain walkable, and
 * does it reach every session? The planner's check panel renders `errors`
 * red (must fix: branch, cycle, disconnected start) and `stranded` amber
 * (sessions the walker will never reach). Hand-wiring the seam after an
 * insert is the expected workflow — this is its referee.
 */
export interface ChainHealth {
  errors: string[];
  /** Session node ids not on the login chain. */
  stranded: string[];
}

export function chainHealth(g: ProcessGraph): ChainHealth {
  if (g.schema !== 'process-graph/2') return { errors: [], stranded: [] };
  const sessions = g.nodes.filter((n) => n.type === 'session').map((n) => n.id);
  if (!sessions.length) return { errors: [], stranded: [] };
  let chain: string[];
  try {
    chain = loginChain(g, 'login chain');
  } catch (e) {
    return { errors: [(e as Error).message], stranded: [] };
  }
  if (!chain.length) {
    return {
      errors: ["start is not connected to any session — draw a login_as edge from start to the first session"],
      stranded: sessions,
    };
  }
  const onChain = new Set(chain);
  return { errors: [], stranded: sessions.filter((id) => !onChain.has(id)) };
}

/**
 * Run-order preview — the exact word the v2 walker will execute: chain
 * sessions in login order, each session's does/asserts/denied edges in
 * DECLARATION order (drawing order in the planner). Pure and schema-only so
 * the planner inlines it; parity with toJourneyV2 is pinned by a unit test.
 */
export interface RunStep {
  index: number;
  sessionId: string;
  actor: string;
  kind: 'does' | 'asserts' | 'denied';
  /** What executes: the catalog name, assert.<checkpoint>, or the denied capability. */
  name: string;
  label?: string;
  edgeId: string;
}

export interface RunOrder {
  steps: RunStep[];
  /** Set when the chain cannot be walked at all (see chainHealth). */
  problem?: string;
}

export function runOrder(g: ProcessGraph): RunOrder {
  if (g.schema !== 'process-graph/2') return { steps: [], problem: 'run-order preview needs a process-graph/2 graph' };
  let chain: string[];
  try {
    chain = loginChain(g, 'login chain');
  } catch (e) {
    return { steps: [], problem: (e as Error).message };
  }
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const steps: RunStep[] = [];
  for (const sessId of chain) {
    const actor = nodeById.get(sessId)?.actor ?? '?';
    for (const e of g.edges) {
      if (e.from !== sessId) continue;
      if (e.type === 'does') {
        steps.push({
          index: steps.length, sessionId: sessId, actor, kind: 'does',
          name: e.data?.catalog ?? `plan.${e.id}`,
          ...(e.label ? { label: e.label } : {}), edgeId: e.id,
        });
      } else if (e.type === 'asserts') {
        const target = nodeById.get(e.to);
        if (target?.type === 'checkpoint') {
          steps.push({
            index: steps.length, sessionId: sessId, actor, kind: 'asserts',
            name: `assert.${target.id}`,
            ...(target.label ? { label: target.label } : {}), edgeId: e.id,
          });
        }
      } else if (e.type === 'denied') {
        steps.push({
          index: steps.length, sessionId: sessId, actor, kind: 'denied',
          name: e.data?.capability ?? '?',
          ...(e.label ? { label: e.label } : {}), edgeId: e.id,
        });
      }
    }
  }
  return { steps };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function uniqueId(taken: Set<string>, prefix: string, base: string): string {
  if (!taken.has(base)) return base;
  let candidate = `${prefix}${base}`;
  let n = 2;
  while (taken.has(candidate)) candidate = `${prefix}${base}_${n++}`;
  return candidate;
}

export function composeGraphs(host: ProcessGraph, sub: ProcessGraph, opts: ComposeOptions = {}): ComposeResult {
  for (const [name, doc] of [['host', host], ['sub', sub]] as const) {
    const v = validateGraph(doc);
    if (!v.ok) throw new Error(`${name} graph invalid:\n - ${v.errors.join('\n - ')}`);
    if (doc.schema !== 'process-graph/2') throw new Error(`${name} graph is ${doc.schema} — compose needs process-graph/2 (open + re-save to upgrade)`);
  }
  if (host.id === sub.id) throw new Error(`cannot import '${sub.id}' into itself`);

  const g: ProcessGraph = JSON.parse(JSON.stringify(host)) as ProcessGraph;
  const s: ProcessGraph = JSON.parse(JSON.stringify(sub)) as ProcessGraph;
  const summary: string[] = [];
  const prefix = `${s.id}_`;
  const mode: 'island' | 'splice' = opts.mode ?? (opts.after ? 'splice' : 'island');

  // ---- actors + systems: agree or error --------------------------------
  for (const [alias, persona] of Object.entries(s.actors)) {
    const existing = g.actors[alias];
    if (existing === undefined) {
      g.actors[alias] = persona;
      summary.push(`actor ${alias} → ${persona} (imported)`);
    } else if (existing !== persona) {
      throw new Error(`actor alias '${alias}' means '${existing}' here but '${persona}' in '${s.id}' — rename the alias in one graph first`);
    }
  }
  for (const [key, def] of Object.entries(s.systems)) {
    const existing = g.systems[key];
    if (existing === undefined) {
      g.systems[key] = def;
      summary.push(`system ${key} (imported)`);
    } else if (!sameJson(existing, def)) {
      throw new Error(`system '${key}' is defined differently in '${s.id}' — align the definitions (urlEnv/sessionPolicy) before composing`);
    }
  }

  // ---- node mapping ----------------------------------------------------
  const hostNodeById = new Map(g.nodes.map((n) => [n.id, n]));
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  const hostChain = loginChain(g, `'${g.id}'`);
  const subChain = loginChain(s, `'${s.id}'`);
  const hostEnd = g.nodes.find((n) => n.type === 'end');

  /** sub node id → id in the composed graph ('' = dropped). */
  const nodeMap = new Map<string, string>();
  const importedNodes: PNode[] = [];

  const sessionMatch = (sess: PNode): PNode | undefined =>
    g.nodes.find(
      (n) =>
        n.type === 'session' && n.system === sess.system && n.actor === sess.actor &&
        sameJson(n.account, sess.account),
    );

  for (const n of s.nodes) {
    if (n.type === 'start' || n.type === 'end') { nodeMap.set(n.id, ''); continue; }

    if (n.type === 'session') {
      // Island mode never merges sessions — the human decides every join.
      const match = mode === 'splice' ? sessionMatch(n) : undefined;
      if (match) {
        nodeMap.set(n.id, match.id);
        summary.push(`session ${n.id} merged into ${match.id} (same system · actor · account); its steps run after the host's`);
        continue;
      }
    } else {
      const same = hostNodeById.get(n.id);
      if (same?.type === n.type) {
        // Merge: union the checks; host keeps its other fields.
        const existingIds = new Set((same.expects ?? []).map((x) => x.id));
        for (const x of n.expects ?? []) {
          const dup = (same.expects ?? []).find((h) => h.id === x.id);
          if (dup && sameJson({ k: dup.kind, t: dup.target, v: dup.value, a: dup.after }, { k: x.kind, t: x.target, v: x.value, a: x.after })) {
            continue; // identical check — one copy is enough
          }
          const xid = existingIds.has(x.id) ? uniqueId(existingIds, prefix, x.id) : x.id;
          existingIds.add(xid);
          same.expects = [...(same.expects ?? []), { ...x, id: xid }];
        }
        nodeMap.set(n.id, same.id);
        summary.push(`${n.type} ${n.id} merged (checks unioned)`);
        continue;
      }
    }

    const newId = uniqueId(nodeIds, prefix, n.id);
    nodeIds.add(newId);
    if (newId !== n.id) summary.push(`${n.type} ${n.id} imported as ${newId}`);
    nodeMap.set(n.id, newId);
    importedNodes.push({ ...n, id: newId });
  }
  g.nodes.push(...importedNodes);

  // ---- edges: remap endpoints; splice the login chain ------------------
  const edgeIds = new Set(g.edges.map((e) => e.id));
  const subStartId = s.nodes.find((n) => n.type === 'start')?.id;
  const subLoginAuth = new Map<string, PEdge['data']>(); // to-session id → login edge data
  for (const e of s.edges) if (e.type === 'login_as') subLoginAuth.set(e.to, e.data);

  const edgeIdMap = new Map<string, string>(); // sub edge id → composed edge id
  const importedEdges: PEdge[] = [];
  for (const e of s.edges) {
    // Splice consumes ALL login_as edges (rebuilt below). Island keeps the
    // sub's INTERNAL chain wiring — only the entry edge from its start goes.
    if (e.type === 'login_as' && mode === 'splice') continue;
    if (e.from === subStartId) continue;
    const from = nodeMap.get(e.from) ?? e.from;
    let to = nodeMap.get(e.to) ?? e.to;
    if (to === '') {
      if (mode === 'island' || !hostEnd) {
        summary.push(`edge ${e.id} (…→ end) dropped — relink to end once the island is wired in`);
        continue;
      }
      to = hostEnd.id; // splice: sub's end → host's end
    }
    if (from === '') { summary.push(`edge ${e.id} dropped (source was the sub's start)`); continue; }
    const newId = uniqueId(edgeIds, prefix, e.id);
    edgeIds.add(newId);
    edgeIdMap.set(e.id, newId);
    importedEdges.push({ ...e, id: newId, from, to });
  }
  g.edges.push(...importedEdges);

  // Checks imported with an `after` pointing at a renamed edge follow it.
  for (const n of g.nodes) {
    for (const x of n.expects ?? []) {
      if (x.after && edgeIdMap.has(x.after) && edgeIdMap.get(x.after) !== x.after) {
        x.after = edgeIdMap.get(x.after)!;
      }
    }
  }

  // Island: nothing is wired — report what waits for the human's hand.
  if (mode === 'island') {
    const arrivals = subChain.map((id) => nodeMap.get(id)!).filter((id) => id !== '');
    if (arrivals.length) {
      summary.push(
        `island: ${arrivals.join(' → ')} arrived UNWIRED — draw a login_as edge from a previous session into ${arrivals[0]}, ` +
          `then unlink/relink end. check ✓ lists them until you do`,
      );
    } else {
      summary.push('island: no sessions to wire — only data/infra arrived');
    }
  }

  // Splice: sub-chain sessions that did NOT merge into the host enter the
  // chain after `opts.after` (default: the last host session).
  const inserted = mode === 'splice'
    ? subChain.map((id) => nodeMap.get(id)!).filter((id) => id !== '' && !hostChain.includes(id))
    : [];
  if (inserted.length) {
    const after = opts.after ?? hostChain[hostChain.length - 1];
    if (!after || !hostChain.includes(after)) {
      throw new Error(`after '${opts.after ?? '(none)'}' is not a session in the host chain — chain: ${hostChain.join(' → ')}`);
    }
    const oldNext = g.edges.find((e) => e.type === 'login_as' && e.from === after);
    if (oldNext) g.edges = g.edges.filter((e) => e !== oldNext);

    const authFor = (composedId: string): PEdge['data'] => {
      for (const [subId, mapped] of nodeMap) if (mapped === composedId) return subLoginAuth.get(subId);
      return undefined;
    };
    let cursor = after;
    for (const sessId of inserted) {
      const id = uniqueId(edgeIds, prefix, `e_login_${sessId}`);
      edgeIds.add(id);
      const data = authFor(sessId);
      g.edges.push({ id, from: cursor, to: sessId, type: 'login_as', ...(data ? { data } : {}) });
      cursor = sessId;
    }
    if (oldNext) {
      const id = uniqueId(edgeIds, prefix, `e_login_return`);
      edgeIds.add(id);
      g.edges.push({ id, from: cursor, to: oldNext.to, type: 'login_as', ...(oldNext.data ? { data: oldNext.data } : {}) });
    }
    summary.push(`chain spliced after ${after}: + ${inserted.join(' → ')}${oldNext ? ` → back to ${oldNext.to}` : ''}`);
  } else if (mode === 'splice') {
    summary.push('no new sessions — every sub session merged into the host chain');
  }

  g.composedFrom = [
    ...(g.composedFrom ?? []),
    { ref: opts.ref ?? s.id, graphId: s.id, at: opts.now ?? new Date().toISOString() },
  ];

  // ---- the composed graph must still validate AND walk linearly --------
  const v = validateGraph(g);
  if (!v.ok) throw new Error(`compose produced an invalid graph (bug):\n - ${v.errors.join('\n - ')}`);
  loginChain(g, 'composed graph');

  summary.push(`now ${g.nodes.length} nodes · ${g.edges.length} edges · imported from '${s.id}'`);
  return { graph: g, summary };
}
