/**
 * S2.1 — the SCRIPT form of a v2 process graph, and the codec both ways
 * (docs/REVIEW-SIMPLIFICATION-2026-09-03.md §5.1).
 *
 * A valid graph has a canonical linear shape — exactly one `login_as` chain,
 * steps in declaration order inside a session, checks on the state the step
 * lands in — and that shape IS a numbered script. So the authoring surface
 * can be text: `parseScript` reads it into a ProcessGraph (never throwing —
 * every complaint comes back as a numbered problem), `printScript` writes a
 * graph back out and NAMES what the text cannot carry (`dropped`) so a UI can
 * warn instead of silently losing it.
 *
 * Deliberately NOT here: port inference. A step may STATE its port
 * (`-> produces`); when it does not, the edge is left portless and
 * inferPorts() drafts one later — one inference engine, not two.
 *
 * The contract is the prototype's (docs/PROTOTYPE-journey-script-planner.html,
 * `parseScript` + `toGraph`); this is the authoritative version. Where the
 * grammar had to grow to survive a round trip through the four shipped graphs
 * — persona bindings, system attributes, explicit catalogs, screens and
 * checkpoints — the addition is PRINTED ONLY when the derived value would be
 * wrong, so a hand-written script stays as short as the prototype's.
 *
 * Grammar (see docs/GRAPH-SPEC.md §13 for the normative copy):
 *
 *   <id>  <title>
 *   systems: sf = Salesforce UAT (url:SF_INSTANCE_URL), siebel = Siebel (max:1)
 *   tags: smoke, sod
 *
 *   as <role> [(<persona>)] [on <system>] [at <url>] [via <auth>]
 *     <verb> <Record> [(<SObject>)] [-> produces|consumes|updates[?]] [as <handle>] [[<catalog>]]
 *     <verb> screen <Screen name> [[<catalog>]]
 *     verify <Checkpoint name>
 *     must not <verb> <Record> [[<capability>]]
 *       ✓ <kind> [<target>] [<value…>] [within <n>ms [every <n>ms]]
 *       ? <kind> …                       (same, but draft:true)
 */

import { loginChain, runOrder } from './compose';
import { slug } from './fromAdo';
import {
  EXPECTATION_KINDS, SYSTEM_KINDS, validateGraph,
  type AuthMethod, type DataIo, type Expectation, type PNode,
  type ProcessGraph, type SystemDef, type SystemKind,
} from './schema';

// ---------- public shapes ----------

export interface ScriptProblem {
  /** 1-based line in the script text (1 for whole-document complaints). */
  line: number;
  message: string;
}

export interface ParseScriptResult {
  graph: ProcessGraph;
  problems: ScriptProblem[];
}

export interface PrintScriptResult {
  text: string;
  /**
   * What the script form cannot say about THIS graph — `<what>: <ids>`, one
   * entry per kind, sorted. Positions, capture state, timing, provenance,
   * infra nodes and the edges into them have no place in a script; a UI shows
   * this so a round trip through the editor is never a silent deletion.
   */
  dropped: string[];
}

// ---------- constants ----------

const ID_RE = /^[a-z][a-z0-9_]*$/;
const SOBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const BACKEND_KIND_RE = /^(?:api|db|log)\./;
const AUTH_METHODS: AuthMethod[] = ['frontdoor', 'singleaccess', 'ui'];
const DEFAULT_SYSTEM_KEY = 'sf';

/** The systems block a script with no `systems:` line means. */
function defaultSystems(): Record<string, SystemDef> {
  return { [DEFAULT_SYSTEM_KEY]: { label: 'Salesforce', kind: 'salesforce' } };
}

/** `<record-slug-head>.<verb>` — the prototype's catalogOf, verbatim. */
export function catalogOf(record: string, verb: string): string {
  const head = slug(record).split('_')[0] ?? '';
  return `${head || 'step'}.${slug(verb) || 'step'}`;
}

function defaultKindFor(key: string): SystemKind {
  if (key === DEFAULT_SYSTEM_KEY) return 'salesforce';
  const known = SYSTEM_KINDS.find((k) => k === key);
  return known ?? 'web';
}

// ---------- parse ----------

type Line =
  | { k: 'header'; n: number; text: string }
  | { k: 'systems'; n: number; text: string }
  | { k: 'tags'; n: number; text: string }
  | { k: 'session'; n: number; text: string }
  | { k: 'step'; n: number; text: string }
  | { k: 'check'; n: number; text: string; draft: boolean };

// `check` is also a legitimate STEP verb ("check the customer is created"), so
// the spelled-out prefix is only a check line when a known oracle kind follows;
// ✓ and ? are unambiguous.
const CHECK_RE = /^(✓|\?|check)\s+(.+)$/;

function isCheckLine(m: RegExpExecArray): boolean {
  if (m[1] !== 'check') return true;
  const kind = (m[2] ?? '').split(/\s+/)[0];
  return EXPECTATION_KINDS.some((k) => k === kind);
}

function tokenize(text: string): Line[] {
  const lines: Line[] = [];
  let headerSeen = false;
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const n = i + 1;
    const body = raw.trim();
    if (!body || body.startsWith('#')) continue;
    const check = CHECK_RE.exec(body);
    if (check && isCheckLine(check)) {
      lines.push({ k: 'check', n, text: (check[2] ?? '').trim(), draft: check[1] === '?' });
      continue;
    }
    if (/^systems?\s*:/i.test(body)) { lines.push({ k: 'systems', n, text: body.replace(/^systems?\s*:/i, '').trim() }); continue; }
    if (/^tags?\s*:/i.test(body)) { lines.push({ k: 'tags', n, text: body.replace(/^tags?\s*:/i, '').trim() }); continue; }
    if (/^as\s+/i.test(body)) { lines.push({ k: 'session', n, text: body.replace(/^as\s+/i, '').trim() }); continue; }
    const indent = /^\s*/.exec(raw)?.[0].length ?? 0;
    if (!headerSeen && indent === 0) { headerSeen = true; lines.push({ k: 'header', n, text: body }); continue; }
    lines.push({ k: 'step', n, text: body });
  }
  return lines;
}

interface StepLine {
  verb: string;
  target: string;
  sobject: string | undefined;
  io: DataIo | undefined;
  ioDraft: boolean;
  handle: string | undefined;
  catalog: string | undefined;
  denied: boolean;
  screen: boolean;
  /** Any of (SObject) / -> port / as handle / [catalog] was written. */
  annotated: boolean;
}

/** Peel the trailing annotations off a step line, then split verb from target. */
function parseStepLine(text: string): StepLine {
  let rest = text;
  let catalog: string | undefined;
  let handle: string | undefined;
  let io: DataIo | undefined;
  let ioDraft = false;
  let sobject: string | undefined;
  let sobjectSlot = false;
  for (;;) {
    let m: RegExpExecArray | null;
    if (catalog === undefined && (m = /^(.*?)\s*\[([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)\]$/.exec(rest))) {
      catalog = m[2]; rest = m[1] ?? ''; continue;
    }
    if (handle === undefined && (m = /^(.*\S)\s+as\s+([a-z][a-z0-9_]*)$/.exec(rest))) {
      handle = m[2]; rest = m[1] ?? ''; continue;
    }
    if (io === undefined && (m = /^(.*?)\s*->\s*(produces|consumes|updates)(\??)$/.exec(rest))) {
      io = m[2] as DataIo; ioDraft = m[3] === '?'; rest = m[1] ?? ''; continue;
    }
    if (!sobjectSlot && (m = /^(.*\S)\s*\((-|[A-Za-z][A-Za-z0-9_]*)\)$/.exec(rest))) {
      sobjectSlot = true;
      if (m[2] !== '-') sobject = m[2];
      rest = m[1] ?? '';
      continue;
    }
    break;
  }
  rest = rest.trim();
  const denied = /^must\s+not\b/i.test(rest);
  if (denied) rest = rest.replace(/^must\s+not\b\s*/i, '').trim();
  const words = rest.split(/\s+/).filter(Boolean);
  const verb = words[0] ?? '';
  let screen = false;
  let target = words.slice(1).join(' ');
  if (/^screens?$/i.test(words[1] ?? '')) { screen = true; target = words.slice(2).join(' '); }
  return {
    verb, target, sobject, io, ioDraft, handle, catalog, denied, screen,
    annotated: catalog !== undefined || handle !== undefined || io !== undefined || sobjectSlot,
  };
}

/** A `verify X` line is a CHECKPOINT unless X names a record or it is annotated. */
function isCheckpointLine(s: StepLine, recordLabels: ReadonlySet<string>): boolean {
  return !s.denied && !s.screen && !s.annotated && s.verb.toLowerCase() === 'verify' && !recordLabels.has(s.target);
}

function parseSystemsLine(text: string, n: number, into: Record<string, SystemDef>, problems: ScriptProblem[]): void {
  const marks: { key: string; from: number; to: number }[] = [];
  const re = /([a-z][a-z0-9_]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) marks.push({ key: m[1] ?? '', from: m.index, to: re.lastIndex });
  if (!marks.length) { problems.push({ line: n, message: `systems: expected 'key = Label' entries, got '${text}'` }); return; }
  for (const [i, mark] of marks.entries()) {
    const end = marks[i + 1]?.from ?? text.length;
    let value = text.slice(mark.to, end).trim().replace(/,$/, '').trim();
    let kind: SystemKind | undefined;
    let urlEnv: string | undefined;
    let maxConcurrent: number | undefined;
    const anno = /^(.*\S)\s*\(([^)]*)\)$/.exec(value);
    if (anno) {
      value = (anno[1] ?? '').trim();
      const tokens = (anno[2] ?? '').replace(/\b(max|url)\s+/gi, '$1:').split(/[\s,]+/).filter(Boolean);
      for (const tok of tokens) {
        const url = /^url:(.+)$/i.exec(tok);
        const max = /^max:(\d+)$/i.exec(tok);
        const asKind = SYSTEM_KINDS.find((k) => k === tok.toLowerCase());
        if (url) urlEnv = url[1];
        else if (max) maxConcurrent = Number(max[1]);
        else if (asKind) kind = asKind;
        else problems.push({ line: n, message: `systems.${mark.key}: unknown attribute '${tok}' (expected a system kind, url:ENV_NAME or max:N)` });
      }
    }
    if (!ID_RE.test(mark.key)) { problems.push({ line: n, message: `systems.${mark.key}: key must be lower_snake_case` }); continue; }
    if (urlEnv !== undefined && !ENV_NAME_RE.test(urlEnv)) {
      problems.push({ line: n, message: `systems.${mark.key}: url must be an ENV VAR NAME (got '${urlEnv}')` });
      urlEnv = undefined;
    }
    into[mark.key] = {
      label: value || mark.key,
      kind: kind ?? defaultKindFor(mark.key),
      ...(urlEnv !== undefined ? { urlEnv } : {}),
      ...(maxConcurrent !== undefined ? { sessionPolicy: { maxConcurrent } } : {}),
    };
  }
}

interface SessionLine {
  role: string;
  persona: string | undefined;
  system: string | undefined;
  url: string | undefined;
  auth: AuthMethod | undefined;
  authText: string | undefined;
}

function parseSessionLine(text: string): SessionLine {
  let rest = text;
  let auth: AuthMethod | undefined;
  let authText: string | undefined;
  let url: string | undefined;
  let system: string | undefined;
  let via: RegExpExecArray | null;
  if ((via = /^(.*\S)\s+via\s+(\S+)$/i.exec(rest))) {
    rest = via[1] ?? '';
    authText = via[2];
    auth = AUTH_METHODS.find((a) => a === authText?.toLowerCase());
  }
  const at = /^(.*\S)\s+at\s+(\S+)$/i.exec(rest);
  if (at) { rest = at[1] ?? ''; url = at[2]; }
  const on = /^(.*\S)\s+on\s+(\S.*)$/i.exec(rest);
  if (on) { rest = on[1] ?? ''; system = (on[2] ?? '').trim(); }
  const persona = /^(.*\S)\s*\(([a-z][a-z0-9_]*)\)$/.exec(rest);
  if (persona) { rest = persona[1] ?? ''; }
  return { role: rest.trim(), persona: persona?.[2], system, url, auth, authText };
}

/** Split a check body into an Expectation, or say why it cannot be one. */
function parseCheck(text: string, id: string, after: string | undefined, draft: boolean): Expectation | string {
  let rest = text.trim();
  let timeoutMs: number | undefined;
  let pollMs: number | undefined;
  const within = /\bwithin\b\s*(\S*)\s*(?:every\s*(\S*)\s*)?$/i.exec(rest);
  if (within) {
    const t = /^(\d+)ms$/i.exec(within[1] ?? '');
    const p = within[2] === undefined ? undefined : /^(\d+)ms$/i.exec(within[2]);
    if (!t || (within[2] !== undefined && !p)) return "malformed timing — expected 'within <n>ms [every <n>ms]'";
    timeoutMs = Number(t[1]);
    if (p) pollMs = Number(p[1]);
    rest = rest.slice(0, within.index).trim();
  }
  const words = rest.split(/\s+/).filter(Boolean);
  const kindText = words[0] ?? '';
  const kind = EXPECTATION_KINDS.find((k) => k === kindText);
  if (!kind) return `unknown check kind '${kindText}' — one of ${EXPECTATION_KINDS.join('|')}`;
  if (kind === 'db.query' || kind === 'log.traffic') {
    return `${kind} needs a db/logger node as its target — infra evidence is not expressible in script form`;
  }
  const body = words.slice(1).join(' ');
  const backend = BACKEND_KIND_RE.test(kind);
  let target: string | undefined;
  let value: string | undefined;
  if (backend) {
    target = words[1];
    value = words.slice(2).join(' ') || undefined;
  } else if (kind === 'ui.visible') {
    target = body || undefined;
  } else {
    value = body || undefined;
  }
  if (kind === 'ui.visible' && !target) return 'ui.visible needs a target (the role/label/text to see)';
  if (backend && !target) return `${kind} needs a target (the SObject)`;
  if ((kind === 'ui.text' || kind === 'ui.toast' || kind === 'ui.url' || kind === 'api.field_equals') && !value) {
    return `${kind} needs a value (the expected text/url/Field=Value)`;
  }
  if (timeoutMs !== undefined && (timeoutMs < 100 || timeoutMs > 600_000)) return 'within: 100..600000ms';
  if (pollMs !== undefined) {
    if (!backend) return 'every: only backend oracles (api./db./log.) poll';
    if (pollMs < 100) return 'every: at least 100ms';
    if (timeoutMs !== undefined && pollMs >= timeoutMs) return 'every: must be shorter than within';
  }
  return {
    id, kind,
    ...(target !== undefined ? { target } : {}),
    ...(value !== undefined ? { value } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(pollMs !== undefined ? { pollMs } : {}),
    ...(draft ? { draft: true } : {}),
  };
}

export function parseScript(text: string): ParseScriptResult {
  const problems: ScriptProblem[] = [];
  const lines = tokenize(text);

  // Pass 1 — which target names are RECORDS? `verify X` is a checkpoint only
  // when X is not one of them, so the whole document has to be seen first.
  const recordLabels = new Set<string>();
  for (const line of lines) {
    if (line.k !== 'step') continue;
    const s = parseStepLine(line.text);
    if (!s.target || s.screen) continue;
    if (s.verb.toLowerCase() === 'verify' && !s.annotated && !s.denied) continue;
    recordLabels.add(s.target);
  }

  // Header, systems, tags.
  const header = lines.find((l) => l.k === 'header');
  let id = 'new_process';
  let title = '';
  if (header) {
    // Split ONCE: the title keeps whatever spacing it was written with.
    const split = /^(\S+)(?:\s{2,}|\t+)([\s\S]*)$/.exec(header.text);
    id = (split?.[1] ?? header.text).trim();
    title = (split?.[2] ?? '').trim();
    if (!ID_RE.test(id)) {
      problems.push({ line: header.n, message: `id '${id}' is not lower_snake_case — using '${slug(id) || 'new_process'}'` });
      id = slug(id) || 'new_process';
    }
  } else {
    problems.push({ line: 1, message: "no header line — expected '<id>  <title>' first" });
  }

  const systems: Record<string, SystemDef> = {};
  for (const line of lines) if (line.k === 'systems') parseSystemsLine(line.text, line.n, systems, problems);
  if (!Object.keys(systems).length) Object.assign(systems, defaultSystems());

  const tags: string[] = [];
  for (const line of lines) {
    if (line.k !== 'tags') continue;
    for (const raw of line.text.split(/[,\s]+/).filter(Boolean)) {
      const t = slug(raw);
      if (!ID_RE.test(t)) { problems.push({ line: line.n, message: `tag '${raw}' is not a lower_snake_case label` }); continue; }
      if (!tags.includes(t)) tags.push(t);
    }
  }

  const graph: ProcessGraph = {
    schema: 'process-graph/2',
    id,
    ...(title ? { title } : {}),
    systems,
    actors: {},
    nodes: [{ id: 'start', type: 'start', label: '' }],
    edges: [],
    ...(tags.length ? { tags } : {}),
  };

  const systemKeys = Object.keys(systems);
  const usedIds = new Set<string>(['start', 'end']);
  const nodeById = new Map<string, PNode>();
  const records = new Map<string, PNode>();
  const states = new Map<string, PNode>();          // screen/checkpoint by label
  const sessions = new Map<string, PNode>();
  const usedCatalogs = new Set<string>();

  const takeId = (base: string, fallback: string): string => {
    let want = slug(base);
    if (!ID_RE.test(want)) want = fallback;
    let out = want;
    let k = 2;
    while (usedIds.has(out)) out = `${want}_${k++}`;
    usedIds.add(out);
    return out;
  };
  const addNode = (node: PNode): PNode => { graph.nodes.push(node); nodeById.set(node.id, node); return node; };

  let edgeSeq = 0;
  const nextEdgeId = (): string => `e${++edgeSeq}`;
  let chainTail = 'start';
  let session: PNode | undefined;
  let step: { node: PNode; catalog: string | undefined; checks: number } | undefined;

  for (const line of lines) {
    if (line.k === 'session') {
      const s = parseSessionLine(line.text);
      const alias = slug(s.role) || `role_${sessions.size + 1}`;
      if (!ID_RE.test(alias)) { problems.push({ line: line.n, message: `role '${s.role}' has no usable alias` }); continue; }
      let systemKey = systemKeys[0] ?? DEFAULT_SYSTEM_KEY;
      if (s.system !== undefined) {
        const named = systemKeys.find((k) => k === s.system)
          ?? systemKeys.find((k) => systems[k]?.label.toLowerCase() === s.system?.toLowerCase());
        if (named !== undefined) systemKey = named;
        else problems.push({ line: line.n, message: `unknown system '${s.system}' — declared: ${systemKeys.join(', ')}` });
      }
      if (s.authText !== undefined && s.auth === undefined) {
        problems.push({ line: line.n, message: `unknown auth '${s.authText}' — one of ${AUTH_METHODS.join('|')}` });
      }
      const persona = s.persona ?? alias;
      const known = graph.actors[alias];
      if (known !== undefined && known !== persona) {
        problems.push({ line: line.n, message: `actor '${alias}' is already bound to persona '${known}' — ignoring '${persona}'` });
      } else graph.actors[alias] = persona;

      const sessId = `sess_${systemKey}_${alias}`;
      const existing = sessions.get(sessId);
      if (existing) { session = existing; step = undefined; continue; }
      usedIds.add(sessId);
      let url = s.url;
      if (url !== undefined && /:\/\/[^/]*:[^/@]*@/.test(url)) {
        problems.push({ line: line.n, message: 'url embeds credentials — never store user:pass in a URL' });
        url = undefined;
      }
      session = addNode({
        id: sessId, type: 'session',
        label: `${systems[systemKey]?.label ?? systemKey} · ${alias}`,
        system: systemKey, actor: alias,
        ...(url !== undefined ? { url } : {}),
      });
      sessions.set(sessId, session);
      graph.edges.push({
        id: nextEdgeId(), from: chainTail, to: sessId, type: 'login_as',
        ...(s.auth !== undefined ? { data: { auth: s.auth } } : {}),
      });
      chainTail = sessId;
      step = undefined;
      continue;
    }

    if (line.k === 'step') {
      const s = parseStepLine(line.text);
      if (!session) { problems.push({ line: line.n, message: `step '${line.text}' comes before any 'as <role>' session line` }); continue; }
      if (!s.verb) { problems.push({ line: line.n, message: `'${line.text}' names no verb` }); continue; }
      if (!s.target) { problems.push({ line: line.n, message: `'${line.text}' names no record` }); continue; }

      if (isCheckpointLine(s, recordLabels)) {
        let node = states.get(`checkpoint ${s.target}`);
        if (!node) {
          node = addNode({ id: takeId(s.target, `chk_${states.size + 1}`), type: 'checkpoint', label: s.target });
          states.set(`checkpoint ${s.target}`, node);
        }
        graph.edges.push({ id: nextEdgeId(), from: session.id, to: node.id, type: 'asserts' });
        step = { node, catalog: undefined, checks: 0 };
        continue;
      }

      let node: PNode | undefined;
      if (s.screen) {
        node = states.get(`screen ${s.target}`);
        if (!node) {
          node = addNode({ id: takeId(s.target, `scr_${states.size + 1}`), type: 'screen', label: s.target });
          states.set(`screen ${s.target}`, node);
        }
      } else {
        node = records.get(s.target);
        if (!node) {
          node = addNode({
            id: takeId(s.target, `data_${records.size + 1}`), type: 'data', label: s.target,
            ...(s.sobject !== undefined ? { sobject: s.sobject } : {}),
            ...(s.handle !== undefined ? { ref: s.handle } : {}),
          });
          records.set(s.target, node);
        } else {
          if (s.sobject !== undefined && node.sobject !== undefined && node.sobject !== s.sobject) {
            problems.push({ line: line.n, message: `record '${s.target}' is already (${node.sobject}) — ignoring (${s.sobject})` });
          } else if (s.sobject !== undefined && node.sobject === undefined) node.sobject = s.sobject;
          if (s.handle !== undefined && node.ref !== undefined && node.ref !== s.handle) {
            problems.push({ line: line.n, message: `record '${s.target}' already has handle '${node.ref}' — ignoring '${s.handle}'` });
          } else if (s.handle !== undefined && node.ref === undefined) node.ref = s.handle;
        }
      }

      const catalog = s.catalog ?? catalogOf(s.target, s.verb);
      if (s.denied) {
        // A refusal asserts nothing, so it opens no check group and its
        // capability may legitimately equal another session's catalog.
        graph.edges.push({
          id: nextEdgeId(), from: session.id, to: node.id, type: 'denied',
          label: `must NOT ${s.verb}`, data: { capability: catalog },
        });
        step = undefined;
        continue;
      }
      if (usedCatalogs.has(catalog)) {
        problems.push({ line: line.n, message: `catalog '${catalog}' is used twice — the second check group cannot be told apart` });
      } else usedCatalogs.add(catalog);
      graph.edges.push({
        id: nextEdgeId(), from: session.id, to: node.id, type: 'does',
        label: `${s.verb} ${s.target}`.toLowerCase(),
        data: { catalog, ...(s.io !== undefined ? { io: s.io, ...(s.ioDraft ? { ioDraft: true } : {}) } : {}) },
      });
      step = { node, catalog, checks: 0 };
      continue;
    }

    if (line.k === 'check') {
      if (!step) { problems.push({ line: line.n, message: `check '${line.text}' comes before any step line` }); continue; }
      const current = step;
      current.checks += 1;
      const base = slug(current.catalog ?? current.node.id) || current.node.id;
      const parsed = parseCheck(line.text, `${base}_${current.checks}`, current.catalog, line.draft);
      if (typeof parsed === 'string') { problems.push({ line: line.n, message: parsed }); continue; }
      current.node.expects = [...(current.node.expects ?? []), parsed];
    }
  }

  const end: PNode = { id: 'end', type: 'end', label: '' };
  graph.nodes.push(end);
  graph.edges.push({ id: nextEdgeId(), from: chainTail, to: 'end', type: 'next' });

  // Two data nodes must never share a runtime handle (validator rule) — a
  // duplicate `as <handle>` is reported and the second one dropped.
  const handles = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.type !== 'data') continue;
    const ref = n.ref ?? n.id;
    const other = handles.get(ref);
    if (other !== undefined && n.ref !== undefined) {
      problems.push({ line: 1, message: `handle '${ref}' is already used by record '${other}'` });
      delete n.ref;
    } else handles.set(ref, n.id);
  }

  // Safety net: parseScript promises a graph the validator accepts. Anything
  // that still trips it is a codec bug, surfaced rather than swallowed.
  const v = validateGraph(graph);
  for (const err of v.errors) problems.push({ line: 1, message: `invalid graph: ${err}` });
  return { graph, problems };
}

// ---------- print ----------

function pushDropped(into: Map<string, string[]>, kind: string, id: string): void {
  const list = into.get(kind);
  if (!list) into.set(kind, [id]);
  else if (!list.includes(id)) list.push(id);
}

function printSystems(systems: Record<string, SystemDef>): string {
  return Object.entries(systems).map(([key, s]) => {
    const anno: string[] = [];
    if (s.kind !== defaultKindFor(key)) anno.push(s.kind);
    if (s.urlEnv !== undefined) anno.push(`url:${s.urlEnv}`);
    if (s.sessionPolicy !== undefined) anno.push(`max:${s.sessionPolicy.maxConcurrent}`);
    return `${key} = ${s.label}${anno.length ? ` (${anno.join(' ')})` : ''}`;
  }).join(', ');
}

function isDefaultSystems(systems: Record<string, SystemDef>): boolean {
  const keys = Object.keys(systems);
  const only = systems[DEFAULT_SYSTEM_KEY];
  return keys.length === 1 && !!only && only.label === 'Salesforce' && only.kind === 'salesforce'
    && only.urlEnv === undefined && only.sessionPolicy === undefined;
}

/** The verb a step line should carry, and the catalog it cannot derive. */
function verbFor(targetLabel: string, catalog: string | undefined, label: string | undefined): { verb: string; explicit?: string } {
  if (catalog !== undefined) {
    const head = slug(targetLabel).split('_')[0] ?? '';
    if (head && catalog.startsWith(`${head}.`)) {
      const verb = catalog.slice(head.length + 1);
      if (ID_RE.test(verb) && catalogOf(targetLabel, verb) === catalog) return { verb };
    }
  }
  const fromLabel = slug((label ?? '').split(/\s+/).find((w) => /[a-z]/i.test(w)) ?? '') || 'do';
  return catalog === undefined ? { verb: fromLabel } : { verb: fromLabel, explicit: catalog };
}

/** The `(SObject)` slot — also the escape hatch for a label ending in ')'. */
function sobjectSlot(label: string, sobject: string | undefined): string {
  if (sobject !== undefined && SOBJECT_RE.test(sobject)) return ` (${sobject})`;
  return label.endsWith(')') ? ' (-)' : '';
}

function printCheck(x: Expectation, draftMark: boolean, dropped: Map<string, string[]>): string {
  const parts: string[] = [x.kind];
  const backend = BACKEND_KIND_RE.test(x.kind);
  if (backend || x.kind === 'ui.visible') {
    if (x.target !== undefined) parts.push(x.target);
  } else if (x.target !== undefined) pushDropped(dropped, 'expectation target (kind carries none)', x.id);
  if (x.kind === 'ui.visible') {
    if (x.value !== undefined) pushDropped(dropped, 'expectation value (kind carries none)', x.id);
  } else if (x.value !== undefined) parts.push(x.value);
  if (x.timeoutMs !== undefined) {
    parts.push(`within ${x.timeoutMs}ms`);
    if (x.pollMs !== undefined) parts.push(`every ${x.pollMs}ms`);
  } else if (x.pollMs !== undefined) pushDropped(dropped, 'expectation pollMs without timeoutMs', x.id);
  if (x.note !== undefined) pushDropped(dropped, 'expectation note', x.id);
  if (x.lastResult !== undefined) pushDropped(dropped, 'expectation lastResult', x.id);
  return `    ${draftMark ? '?' : '✓'} ${parts.join(' ')}`;
}

export function printScript(graph: ProcessGraph): PrintScriptResult {
  const dropped = new Map<string, string[]>();
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));
  const endId = graph.nodes.find((n) => n.type === 'end')?.id;

  if (graph.composedFrom?.length) pushDropped(dropped, 'graph composedFrom', graph.composedFrom.map((c) => c.ref).join('+'));
  if (graph.alternatives && Object.keys(graph.alternatives).length) {
    for (const alias of Object.keys(graph.alternatives)) pushDropped(dropped, 'graph alternatives', alias);
  }

  for (const n of graph.nodes) {
    if (n.type === 'db' || n.type === 'logger' || n.type === 'api') { pushDropped(dropped, `${n.type} node`, n.id); continue; }
    if (n.pos !== undefined) pushDropped(dropped, 'node pos', n.id);
    if (n.notes !== undefined) pushDropped(dropped, 'node notes', n.id);
    if (n.steps !== undefined) pushDropped(dropped, 'node steps (capture state)', n.id);
    if (n.snapshot !== undefined) pushDropped(dropped, 'node snapshot', n.id);
    if (n.timing !== undefined) pushDropped(dropped, 'node timing', n.id);
    if (n.account !== undefined) pushDropped(dropped, 'session account (usernameEnv)', n.id);
    if (n.origin !== undefined) pushDropped(dropped, 'data node origin', n.id);
  }

  // Session order = the login chain the walker uses; stranded sessions are
  // printed after it so their steps survive, and named as a problem.
  let chain: string[] = [];
  try { chain = loginChain(graph, 'login chain'); } catch (e) { pushDropped(dropped, 'login chain', (e as Error).message); }
  const order = runOrder(graph);
  if (order.problem !== undefined) pushDropped(dropped, 'run order', order.problem);
  const onChain = new Set(chain);
  for (const n of graph.nodes) {
    if (n.type !== 'session' || onChain.has(n.id)) continue;
    pushDropped(dropped, 'stranded session (off the login chain)', n.id);
    chain.push(n.id);
  }

  const stepsBySession = new Map<string, { edgeId: string; kind: 'does' | 'asserts' | 'denied' }[]>();
  for (const s of order.steps) {
    const list = stepsBySession.get(s.sessionId) ?? [];
    list.push({ edgeId: s.edgeId, kind: s.kind });
    stepsBySession.set(s.sessionId, list);
  }
  for (const sessId of chain) {
    if (stepsBySession.has(sessId)) continue;
    const list = graph.edges
      .filter((e) => e.from === sessId && (e.type === 'does' || e.type === 'asserts' || e.type === 'denied'))
      .map((e) => ({ edgeId: e.id, kind: e.type as 'does' | 'asserts' | 'denied' }));
    if (list.length) stepsBySession.set(sessId, list);
  }

  const printedEdges = new Set<string>();
  const printedExpects = new Set<string>();
  const sobjectPrinted = new Set<string>();
  const out: string[] = [];
  out.push(`${graph.id}${graph.title ? `  ${graph.title}` : ''}`);
  if (!isDefaultSystems(graph.systems)) out.push(`systems: ${printSystems(graph.systems)}`);
  if (graph.tags?.length) out.push(`tags: ${graph.tags.join(', ')}`);

  const resolveAfter = (after: string | undefined): string | undefined => {
    if (after === undefined) return undefined;
    const e = edgeById.get(after);
    if (!e) return after;
    return e.data?.catalog ?? e.data?.capability ?? after;
  };

  const multiSystem = Object.keys(graph.systems).length > 1;
  for (const sessId of chain) {
    const node = nodeById.get(sessId);
    if (!node) continue;
    const alias = node.actor;
    if (alias === undefined) pushDropped(dropped, 'session without an actor', sessId);
    const role = alias ?? sessId;
    const persona = alias === undefined ? undefined : graph.actors[alias];
    const login = graph.edges.find((e) => e.type === 'login_as' && e.to === sessId);
    if (login) {
      printedEdges.add(login.id);
      if (login.label !== undefined) pushDropped(dropped, 'edge label', login.id);
    }
    const wantLabel = `${graph.systems[node.system ?? '']?.label ?? node.system ?? ''} · ${role}`;
    if (node.label !== wantLabel) pushDropped(dropped, 'session label', sessId);
    out.push('');
    out.push(`as ${role}`
      + (persona !== undefined && persona !== role ? ` (${persona})` : '')
      + (multiSystem && node.system !== undefined ? ` on ${node.system}` : '')
      + (node.url !== undefined ? ` at ${node.url}` : '')
      + (login?.data?.auth !== undefined ? ` via ${login.data.auth}` : ''));

    for (const s of stepsBySession.get(sessId) ?? []) {
      const edge = edgeById.get(s.edgeId);
      if (!edge) continue;
      const target = nodeById.get(edge.to);
      if (!target) continue;
      printedEdges.add(edge.id);
      for (const field of ['deltaMs', 'meanMs', 'frequency', 'recordRef', 'bind'] as const) {
        if (edge.data?.[field] !== undefined) pushDropped(dropped, `edge data.${field}`, edge.id);
      }

      let catalog: string | undefined;
      let line: string;
      if (s.kind === 'asserts') {
        if (target.type !== 'checkpoint') { pushDropped(dropped, 'asserts edge (target is not a checkpoint)', edge.id); continue; }
        line = `  verify ${target.label}${sobjectSlot(target.label, undefined)}`;
        if (edge.label !== undefined) pushDropped(dropped, 'edge label', edge.id);
      } else {
        if (target.type !== 'data' && target.type !== 'screen') {
          pushDropped(dropped, `${s.kind} edge onto a ${target.type} node`, edge.id);
          continue;
        }
        const named = s.kind === 'denied' ? edge.data?.capability : edge.data?.catalog;
        if (s.kind !== 'denied') catalog = named;
        if (named === undefined) pushDropped(dropped, `${s.kind} edge without a catalog (one is derived)`, edge.id);
        const { verb, explicit } = verbFor(target.label, named, edge.label);
        const io = edge.data?.io;
        const firstTouch = !sobjectPrinted.has(target.id);
        sobjectPrinted.add(target.id);
        line = `  ${s.kind === 'denied' ? 'must not ' : ''}${verb} ${target.type === 'screen' ? 'screen ' : ''}${target.label}`
          + sobjectSlot(target.label, firstTouch && target.type === 'data' ? target.sobject : undefined)
          + (io !== undefined ? ` -> ${io}${edge.data?.ioDraft === true ? '?' : ''}` : '')
          + (firstTouch && target.type === 'data' && target.ref !== undefined ? ` as ${target.ref}` : '')
          + (explicit !== undefined ? ` [${explicit}]` : '');
        const want = s.kind === 'denied' ? `must NOT ${verb}` : `${verb} ${target.label}`.toLowerCase();
        if (edge.label !== want) pushDropped(dropped, 'edge label', edge.id);
        if (target.type === 'screen' && target.label.split(/\s+/)[0]?.toLowerCase() === 'screen') {
          pushDropped(dropped, 'screen label starting with "screen"', target.id);
        }
      }
      out.push(line);

      // A refusal owns no checks: `after` names the catalog of a step that
      // DID land, never the capability that was refused.
      if (s.kind === 'denied') continue;
      for (const x of target.expects ?? []) {
        const after = resolveAfter(x.after);
        const mine = s.kind === 'asserts' ? after === undefined : after === catalog;
        if (!mine || printedExpects.has(`${target.id} ${x.id}`)) continue;
        printedExpects.add(`${target.id} ${x.id}`);
        if (x.after !== undefined && after !== x.after) pushDropped(dropped, 'expectation after (edge id rewritten to its catalog)', x.id);
        if (x.kind === 'db.query' || x.kind === 'log.traffic') { pushDropped(dropped, 'expectation (db/log oracle needs an infra node)', x.id); continue; }
        out.push(printCheck(x, x.draft === true, dropped));
      }
    }
  }

  // Anything the walk never reached.
  for (const n of graph.nodes) {
    if (n.type === 'db' || n.type === 'logger' || n.type === 'api') continue;
    for (const x of n.expects ?? []) {
      if (printedExpects.has(`${n.id} ${x.id}`)) continue;
      pushDropped(dropped, 'expectation on a state no step lands in', x.id);
    }
  }
  for (const e of graph.edges) {
    if (printedEdges.has(e.id)) continue;
    if (e.type === 'next' && endId !== undefined && e.to === endId) continue;
    pushDropped(dropped, `${e.type} edge`, e.id);
  }

  // Expectation ids are regenerated as `<slug(catalog)>_<n>`; say so when the
  // authored id would not survive.
  for (const sessId of chain) {
    for (const s of stepsBySession.get(sessId) ?? []) {
      const edge = edgeById.get(s.edgeId);
      const target = edge ? nodeById.get(edge.to) : undefined;
      if (!edge || !target) continue;
      if (s.kind === 'denied') continue;
      const catalog = edge.data?.catalog;
      let k = 0;
      for (const x of target.expects ?? []) {
        const after = resolveAfter(x.after);
        if (s.kind === 'asserts' ? after !== undefined : after !== catalog) continue;
        if (x.kind === 'db.query' || x.kind === 'log.traffic') continue;
        k += 1;
        const base = slug(catalog ?? target.id) || target.id;
        if (x.id !== `${base}_${k}`) pushDropped(dropped, 'expectation id', x.id);
      }
    }
  }

  return {
    text: `${out.join('\n')}\n`,
    dropped: [...dropped].map(([kind, ids]) => `${kind}: ${ids.join(', ')}`).sort(),
  };
}
