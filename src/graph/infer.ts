/**
 * PG-INFER — the guesses the planner should make instead of asking for
 * (REVIEW-SIMPLIFICATION-2026-09-03.md §5.1: "every graph field is derivable
 * from that script").
 *
 * Four inferences, each the machine half of a question the old planner put to
 * the human as a dropdown:
 *
 *  - relationFor()  a drag from A to B implies ONE relation — the 10-item
 *                   edge-type dropdown was the model leaking into the gesture.
 *  - catalogFor()   `<record>.<verb>` from the edge's own words, the same name
 *                   `suggestCatalog()` already computed and then threw into a
 *                   placeholder.
 *  - sessionLabel() `<system> · <actor>`, which the planner printed as the
 *                   literal string "System · role" and never derived again.
 *  - inferPorts()   first-touch data flow (the PROTOTYPE's `analyse()` is the
 *                   contract): the first `does` onto a record produces it,
 *                   later ones update or read it. This is what makes goal 2
 *                   work for HAND-DRAWN edges — fromCapture and fromAdo each
 *                   infer ports for their own importer, and nothing did it
 *                   for an edge drawn on the canvas.
 *
 * Every inference is a DRAFT: `applyInferredPorts()` stamps `ioDraft: true`,
 * which turns gaps.ts's `data_no_port` (an open question) into
 * `data_io_draft` (a question with a default) — confirm-once, the same idiom
 * as the data dictionary and the ADO oracles.
 *
 * NO imports beyond ./schema and ./compose — the planner build inlines this
 * file next to compose.ts so the browser infers exactly what the CLI does.
 */

import type { DataIo, EdgeType, NodeType, PEdge, PNode, ProcessGraph } from './schema';
import { NODE_TYPES } from './schema';
import { runOrder } from './compose';

// ---------- 1. what a drag-to-connect means ----------

export interface RelationRule {
  from: readonly NodeType[];
  to: readonly NodeType[];
  edge: EdgeType;
  /** One line, for the planner's "why this relation?" tooltip. */
  why: string;
}

/**
 * The relation table, in match order. Exported so the UI can EXPLAIN a drag
 * ("session → record = a step") instead of offering ten types and hoping.
 * A pair with no rule returns null — that is the only case where the planner
 * still has to ask.
 */
export const RELATION_RULES: readonly RelationRule[] = [
  { from: ['start', 'session'], to: ['session'], edge: 'login_as', why: 'the login chain — this role signs in next' },
  { from: ['session'], to: ['data', 'screen', 'checkpoint'], edge: 'does', why: 'a step this role performs' },
  { from: ['session'], to: ['db', 'logger', 'api'], edge: 'touches', why: 'evidence or an integration the session reaches — not a scheduled step' },
  { from: ['data', 'api'], to: ['api', 'data'], edge: 'handoff', why: 'the record crossing an integration boundary' },
  // Anything may finish the flow; `end` is the target of no other rule, so
  // this stays last only for readability.
  { from: NODE_TYPES, to: ['end'], edge: 'next', why: 'the flow ends here' },
];

/** The relation a drag from `fromType` to `toType` implies; null = ask. */
export function relationFor(fromType: NodeType, toType: NodeType): EdgeType | null {
  for (const rule of RELATION_RULES) {
    if (rule.from.includes(fromType) && rule.to.includes(toType)) return rule.edge;
  }
  return null;
}

// ---------- 2. the catalog name ----------

/** fromAdo.ts's slug, copied (this file must transpile standalone). */
function slug(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

/** The edge's verb: its label's first word (a one-word label IS the verb). */
export function verbOf(label: string | undefined): string {
  return slug((label ?? '').trim().split(/\s+/)[0] ?? '');
}

/**
 * `<record>.<verb>` — the prototype's `catalogOf`: the HEAD of the target
 * node's label (data nodes are labelled "Customer record") plus the edge's
 * verb, so `create Customer record` → `customer.create`. An edge that already
 * carries a catalog keeps it: this is a suggestion, never a rename.
 */
export function catalogFor(edge: PEdge, graph: ProcessGraph): string {
  const existing = edge.data?.catalog;
  if (existing) return existing;
  const target = graph.nodes.find((n) => n.id === edge.to);
  // A data node is labelled "Customer record"; an unlabelled one still has an
  // id worth naming ('lead_record' → 'lead').
  const name = target?.label;
  const record = slug(name === undefined || name === '' ? edge.to : name).split('_')[0] ?? '';
  const verb = verbOf(edge.label);
  return `${record === '' ? 'record' : record}.${verb === '' ? 'step' : verb}`;
}

// ---------- 3. the session label ----------

/**
 * `<system label> · <actor alias>` — what fromAdo writes for an imported
 * session and what the planner printed as the dead literal "System · role".
 * Placeholders are kept for the halves that are not chosen yet, so the label
 * reads as a prompt rather than as a name.
 */
export function sessionLabel(node: PNode, graph: ProcessGraph): string {
  const key = node.system;
  const def = key === undefined ? undefined : graph.systems[key];
  const system = def !== undefined && def.label !== '' ? def.label : (key ?? 'System');
  return `${system} · ${node.actor ?? 'role'}`;
}

// ---------- 4. first-touch data flow ----------

/**
 * The verb tables, copied from fromAdo.ts's `verbIo` (this file must
 * transpile standalone for the planner; a unit test pins the two together).
 * They are exported because the UI wants to say WHICH verbs it knows.
 */
export const CREATE_VERBS: readonly string[] = ['create', 'convert', 'submit', 'register', 'raise', 'log', 'new'];
export const UPDATE_VERBS: readonly string[] = [
  'update', 'edit', 'approve', 'progress', 'add', 'delete', 'remove', 'change', 'set', 'assign', 'close', 'reject', 'cancel',
];
/** "add a new address" creates one; bare "add" changes what is already there. */
const NEW_PHRASE_RE = /^(add|enter|log)\s+(a\s+|an\s+)?new\b/i;

/** What the WORDS of a step say it does to the record it names. */
export function labelPort(label: string | undefined): DataIo {
  const text = (label ?? '').trim();
  if (NEW_PHRASE_RE.test(text)) return 'produces';
  const verb = verbOf(text);
  if (CREATE_VERBS.includes(verb)) return 'produces';
  if (UPDATE_VERBS.includes(verb)) return 'updates';
  return 'consumes';
}

export interface InferredPort {
  io: DataIo;
  /** true = a guess awaiting confirmation (gaps.ts: `data_io_draft`). */
  draft: boolean;
  /** Why this port, in the words the planner puts in the pill's tooltip. */
  reason: string;
}

export interface InferredPorts {
  /** does-edge id → the port it carries or should carry. */
  ports: Map<string, InferredPort>;
  /** data node id → the edge id that first DEFINES it (a produces). */
  definedBy: Map<string, string>;
}

/**
 * First-touch ports over the ONE walk (`runOrder`), matching the prototype's
 * `analyse()`:
 *
 *  - an explicit `data.io` is respected, always (draft = its `ioDraft`);
 *  - the first `does` onto a record NOTHING has defined yet → `produces`;
 *  - once the record has a definition — an earlier produces, or the node's
 *    `origin: seed | external`, which declares the definition instead of
 *    drawing it — later touches read it: `updates` when the verb changes a
 *    record (CREATE_VERBS ∪ UPDATE_VERBS — a second "create" on a live record
 *    is an overwrite, not a creation), `consumes` otherwise.
 *
 * Position decides `produces`, not the verb: "verify Customer" as the first
 * step of a graph still reads as the definition, exactly as the prototype
 * does — `dataflowHealth()` is the referee that argues with the result, and
 * `data_io_draft` is the question that lets a human overrule it.
 *
 * Only `does` edges on the walked chain are inferred: an edge hanging off a
 * stranded session has no position, so it has no first-touch answer either
 * (chainHealth lists those sessions until they are wired in).
 */
export function inferPorts(graph: ProcessGraph): InferredPorts {
  const ports = new Map<string, InferredPort>();
  const definedBy = new Map<string, string>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

  // Records whose definition is DECLARED rather than drawn — the walk never
  // creates them, so no touch of theirs is a first touch.
  const declared = new Set(
    graph.nodes.filter((n) => n.type === 'data' && (n.origin === 'seed' || n.origin === 'external')).map((n) => n.id),
  );

  for (const step of runOrder(graph).steps) {
    if (step.kind !== 'does') continue;
    const edge = edgeById.get(step.edgeId);
    // Defensive: runOrder builds every step FROM an edge of this graph.
    if (!edge) continue;
    if (nodeById.get(edge.to)?.type !== 'data') continue;

    const explicit = edge.data?.io;
    if (explicit) {
      ports.set(edge.id, {
        io: explicit,
        draft: edge.data?.ioDraft === true,
        reason: `the port is set on the edge (${explicit})`,
      });
      if (explicit === 'produces' && !definedBy.has(edge.to)) definedBy.set(edge.to, edge.id);
      continue;
    }

    const defined = definedBy.has(edge.to) || declared.has(edge.to);
    if (!defined) {
      ports.set(edge.id, { io: 'produces', draft: true, reason: 'first touch on the walk — this step creates the record' });
      definedBy.set(edge.to, edge.id);
      continue;
    }
    const byWords = labelPort(edge.label);
    const origin = declared.has(edge.to) && !definedBy.has(edge.to)
      ? `the record already exists (origin: ${nodeById.get(edge.to)?.origin ?? 'declared'})`
      : 'the record is already defined earlier in the walk';
    ports.set(edge.id, byWords === 'consumes'
      ? { io: 'consumes', draft: true, reason: `${origin} and '${verbOf(edge.label) || 'this step'}' only reads it` }
      : { io: 'updates', draft: true, reason: `${origin} and '${verbOf(edge.label) || 'this step'}' changes it` });
  }
  return { ports, definedBy };
}

/**
 * A COPY of the graph with every portless `does` edge onto a record carrying
 * its inferred port as a draft — the gap turns from `data_no_port` (an open
 * question) into `data_io_draft` (a question with a default the human can
 * accept with one click). Explicit ports are never touched, and the input is
 * never mutated.
 */
export function applyInferredPorts(graph: ProcessGraph): ProcessGraph {
  const { ports } = inferPorts(graph);
  const g = JSON.parse(JSON.stringify(graph)) as ProcessGraph;
  for (const e of g.edges) {
    if (e.data?.io) continue; // an authored port stands
    const p = ports.get(e.id);
    if (!p) continue;
    e.data = { ...e.data, io: p.io, ioDraft: true };
  }
  return g;
}
