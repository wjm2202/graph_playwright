/**
 * S5 — ado:import: an Azure DevOps test plan → a DRAFT process graph the
 * human corrects instead of authors.
 *
 * Two doors, cheapest first (build-order decision: prove the mapping on
 * exports before any REST integration):
 *  - CSV: an ADO query export whose columns include Title and (ideally) the
 *    Steps field — ADO stores steps as XML of <step> pairs
 *    (action, expectedResult), HTML-encoded. The parser is TOLERANT: header
 *    row found by name, quoting per RFC 4180, steps XML or plain lines.
 *  - Paste: numbered/plain lines, `action | expected` or `action -> expected`.
 *
 * The mapping is DELIBERATELY draft-quality — every guess is flagged and
 * every generated oracle carries draft:true (confirm-once idiom, same as the
 * data dictionary). /grillme picks up the flags from here.
 */
import * as fs from 'fs';
import * as path from 'path';
import { validateGraph, type DataIo, type Expectation, type PNode, type ProcessGraph } from './schema';

export interface AdoStep {
  action: string;
  expected?: string;
}

export interface AdoCase {
  id?: string;
  title: string;
  steps: AdoStep[];
}

export interface AdoImportResult {
  graph: ProcessGraph;
  /** Confidence flags — everything grillme should interrogate. */
  flags: string[];
}

// ---------- parsing: CSV / Excel rows ----------

export function parseAdoCsv(text: string): AdoCase[] {
  return casesFromRows(parseCsv(text));
}

/**
 * Cases from a grid of cells — the ONE parser behind CSV and Excel. Two
 * ADO export layouts are recognised by their header row:
 *  - QUERY export: one row per test case, a `Steps` column holding the
 *    steps XML (or plain numbered lines);
 *  - TEST PLANS "Export to Excel": one row per STEP — `Step Action` /
 *    `Step Expected` (or `Action` / `Expected Result`) columns; the case's
 *    Title (and ID) sit on its first row and later rows leave them blank,
 *    or repeat them — both are grouped by ID when present, else by title.
 * The header row is found by name anywhere in the first 20 rows (ADO
 * exports often carry a title/summary row above it), so leading noise is
 * skipped rather than fatal.
 */
export function casesFromRows(rows: string[][]): AdoCase[] {
  const headerAt = rows.slice(0, 20).findIndex((r) => r.some((c) => /^\s*title\s*$/i.test(c)));
  const headerRow = headerAt >= 0 ? rows[headerAt]! : undefined;
  if (!headerRow) {
    if (!rows.length) return [];
    throw new Error(`ADO import: no 'Title' column — got: ${(rows[0] ?? []).join(', ')}`);
  }
  const header = headerRow.map((h) => h.trim().toLowerCase().replace(/\s+/g, ' '));
  const col = (...names: string[]) => {
    for (const name of names) {
      const i = header.findIndex((h) => h === name || h.replace(/\s+/g, '') === name.replace(/\s+/g, ''));
      if (i >= 0) return i;
    }
    return -1;
  };
  const titleIdx = col('title');
  const idIdx = col('id', 'work item id', 'test case id');
  const stepsIdx = col('steps', 'test steps');
  const typeIdx = col('work item type', 'type');
  const actionIdx = col('step action', 'action', 'test step action', 'step');
  const expectedIdx = col('step expected', 'expected result', 'expected', 'step expected result');
  const stepNoIdx = col('step number', 'test step', 'step #', 'step no');
  const perRow = actionIdx >= 0 && (stepsIdx < 0 || expectedIdx >= 0);

  const cases: AdoCase[] = [];
  let current: AdoCase | undefined;
  let currentKey = '';
  for (const row of rows.slice(headerAt + 1)) {
    const cell = (i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');
    const title = cell(titleIdx);
    const id = cell(idIdx);
    const type = cell(typeIdx);
    if (type && !/test\s*case/i.test(type) && (title || !perRow)) continue; // shared steps, requirements…

    if (!perRow) {
      if (!title) continue;
      cases.push({ ...(id ? { id } : {}), title, steps: stepsIdx >= 0 ? parseStepsField(cell(stepsIdx)) : [] });
      continue;
    }

    // Step-per-row: a title (or a new id) opens a case; blank title rows
    // belong to the case above.
    const key = id || title;
    if (title && (!current || key !== currentKey)) {
      current = { ...(id ? { id } : {}), title, steps: [] };
      currentKey = key;
      cases.push(current);
    }
    if (!current) continue;
    const action = cell(actionIdx);
    const expected = cell(expectedIdx);
    // The case's own row may carry step 1 (Test Plans export) or nothing.
    if (action) current.steps.push({ action: cleanAdoHtml(action), ...(expected ? { expected: cleanAdoHtml(expected) } : {}) });
    else if (expected && current.steps.length) {
      const last = current.steps[current.steps.length - 1]!;
      last.expected = [last.expected, cleanAdoHtml(expected)].filter(Boolean).join(' ');
    }
    void stepNoIdx; // ordering is row order; the step number column is informational
  }
  return cases;
}

/** ADO's Steps field: XML of <step> with two parameterizedString children. */
export function parseStepsField(raw: string): AdoStep[] {
  const text = raw.trim();
  if (!text) return [];
  if (!/<steps[\s>]/i.test(text)) return parsePlainSteps(text);
  const steps: AdoStep[] = [];
  const stepRe = /<step\b[^>]*>([\s\S]*?)<\/step>/gi;
  const strRe = /<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>/gi;
  let m: RegExpExecArray | null;
  while ((m = stepRe.exec(text))) {
    const parts: string[] = [];
    let s: RegExpExecArray | null;
    strRe.lastIndex = 0;
    while ((s = strRe.exec(m[1] ?? ''))) parts.push(cleanAdoHtml(s[1] ?? ''));
    const action = (parts[0] ?? '').trim();
    const expected = (parts[1] ?? '').trim();
    if (action) steps.push({ action, ...(expected ? { expected } : {}) });
  }
  return steps;
}

// ---------- parsing: pasted text ----------

export function parseAdoPaste(text: string): AdoCase {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let title = 'imported test case';
  const steps: AdoStep[] = [];
  for (const line of lines) {
    const t = /^title\s*[:=]\s*(.+)$/i.exec(line);
    if (t) {
      title = (t[1] ?? '').trim();
      continue;
    }
    const body = line.replace(/^\d+[.)]\s*/, '');
    const split = body.split(/\s*(?:\||->|=>)\s*/);
    const action = split[0]?.trim();
    const expected = split.slice(1).join(' — ').trim();
    if (action) steps.push({ action, ...(expected ? { expected } : {}) });
  }
  return { title, steps };
}

function parsePlainSteps(text: string): AdoStep[] {
  return parseAdoPaste(text).steps;
}

// ---------- mapping: case → draft graph ----------

const ROLE_RE = /^(?:as|logged\s+in\s+as|login\s+as|acting\s+as)\s+(?:a|an|the)?\s*([^,:]+?)\s*[,:]\s*/i;
/** Real ADO phrasing (ADO Test Plans exports, 2026-09-02): a "pre-req" step that
 *  LISTS who may perform the case, and mid-case "Login with <persona> persona"
 *  steps that switch the actor. Both open a session; the pre-req step itself is
 *  not an action. */
const PREREQ_PERSONAS_RE = /personas?\s+who\s+can\s+perform[^:]*:\s*(.+)$/i;
const LOGIN_WITH_RE = /^(?:log\s*in|login|sign\s*in)\s+(?:to\s+\S+(?:\s+\S+)?\s+)?(?:with|as|using)\s+(?:the\s+|a\s+|an\s+)?["“']?([^"”']+?)["”']?\s*(?:persona|user|role|profile)\b/i;
const LOGIN_ABOVE_RE = /^(?:log\s*in|login|sign\s*in)\b.*\babove\s+personas?\b/i;
const CREATED_RE = /\b(created|saved|exists|persisted|inserted|generated)\b/i;
const TOAST_RE = /\btoast\b/i;
const URL_RE = /\burl\b|\bnavigat/i;
const OBJECT_RE = /\b(?:create|update|edit|open|approve|convert|check|verify|progress|submit|add|delete|remove)\b(?:\s+(?:a|an|the|new|that|if|whether))?\s+([a-z][a-z ]{1,24}?)(?:\s+(?:record|to|into|for|in|with|from|is|are|was|should|has|have|can|cannot|during|on|at)\b|\s*$)/i;

export function adoCaseToGraph(tc: AdoCase, opts: { graphId?: string; knownPersonas?: string[] } = {}): AdoImportResult {
  const flags: string[] = [];
  if (!tc.steps.length) flags.push('no steps found in the test case — only a skeleton was generated');

  const graph: ProcessGraph = {
    schema: 'process-graph/2',
    id: opts.graphId ?? (slug(tc.title) || 'imported_case'),
    title: tc.title,
    systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
    actors: {},
    nodes: [{ id: 'start', type: 'start', label: '' }],
    edges: [],
  };

  // Segment by role phrases; a step with no role stays with the previous one.
  interface Seg { alias: string; roleText: string; steps: AdoStep[] }
  const segs: Seg[] = [];
  const openSession = (roleText: string, first?: AdoStep) => {
    const alias = slug(roleText).slice(0, 40).replace(/_+$/, '') || `role_${segs.length + 1}`;
    const last = segs[segs.length - 1];
    if (last?.alias === alias) { if (first) last.steps.push(first); return; }
    segs.push({ alias, roleText, steps: first ? [first] : [] });
  };
  for (const step of tc.steps) {
    const m = ROLE_RE.exec(step.action);
    const prereq = PREREQ_PERSONAS_RE.exec(step.action);
    const loginWith = LOGIN_WITH_RE.exec(step.action);
    if (m) {
      openSession((m[1] ?? '').trim(), { ...step, action: step.action.slice(m[0].length).trim() || step.action });
    } else if (LOGIN_ABOVE_RE.test(step.action) && segs.length) {
      // "Login to Salesforce SIT with above personas > User converts the lead…"
      // — the pre-req already opened the session; anything after '>' is the
      // first real action.
      const rest = step.action.split(/\s*>\s*/).slice(1).join(' > ').trim();
      if (rest) segs[segs.length - 1]?.steps.push({ ...step, action: rest });
    } else if (prereq) {
      // "Pre req: Personas who can perform this action: A, B, C" — the FIRST
      // named persona plays the case; the others are recorded for the human.
      const names = (prereq[1] ?? '').split(/\s*(?:,|;|\/|\bor\b|\band\b)\s*/i).map((x) => x.replace(/[.\s]+$/, '').trim()).filter(Boolean);
      const chosen = names[0] ?? 'user';
      openSession(chosen);
      flags.push(`pre-req names ${names.length} persona(s) who can perform this case [${names.join(', ')}] — session bound to '${slug(chosen)}'; the rest are alternatives (ask which to test)`);
    } else if (loginWith) {
      // "Login with 'Credit and Collections' persona" mid-case → a NEW session.
      openSession((loginWith[1] ?? '').trim());
    } else if (segs.length) {
      segs[segs.length - 1]?.steps.push(step);
    } else {
      segs.push({ alias: 'user', roleText: '(no role stated)', steps: [step] });
      flags.push(`step 1 names no role ('${trunc(step.action)}') — bound to alias 'user'; grillme should ask`);
    }
  }
  // A session opened by a pre-req/login step with nothing after it is noise.
  for (let k = segs.length - 1; k >= 0; k--) if (!segs[k]!.steps.length && segs.length > 1) segs.splice(k, 1);

  const usedCatalogs = new Set<string>();
  const dataNodes = new Map<string, PNode>();
  let prev = 'start';
  let scr = 0;
  let edgeSeq = 0;

  segs.forEach((seg, i) => {
    const siebelish = /siebel/i.test(seg.roleText) || seg.steps.some((s) => /siebel/i.test(s.action));
    if (siebelish && !graph.systems.siebel) {
      graph.systems.siebel = { label: 'Siebel', kind: 'siebel', sessionPolicy: { maxConcurrent: 1 } };
      flags.push(`'${seg.roleText}' looks like a Siebel role — added the Siebel system with maxConcurrent 1; confirm the session policy`);
    }
    const system = siebelish ? 'siebel' : 'sf';
    graph.actors[seg.alias] = seg.alias;
    if (!opts.knownPersonas?.includes(seg.alias)) {
      flags.push(`role '${seg.roleText}' → persona '${seg.alias}' is NOT in personas.json — grillme must bind it`);
    }
    const sessId = `sess_${seg.alias}`;
    graph.nodes.push({
      id: sessId, type: 'session',
      label: `${graph.systems[system]?.label ?? system} · ${seg.alias}`,
      system, actor: seg.alias,
    });
    graph.edges.push({ id: `e_login_${i + 1}`, from: prev, to: sessId, type: 'login_as' });
    prev = sessId;
    let prevTarget: string | undefined;

    for (const step of seg.steps) {
      edgeSeq += 1;
      const edgeId = `e_do_${edgeSeq}`;
      const object = objectOf(step.action);
      const wantsData = !!step.expected && CREATED_RE.test(step.expected);

      let targetId: string;
      let io: DataIo | undefined;
      const known = object ? dataNodes.get(slug(object)) : undefined;
      if (object && (wantsData || known || verbIo(step.action) === 'produces')) {
        const key = slug(object);
        let node = known;
        if (!node) {
          node = { id: key || `data_${edgeSeq}`, type: 'data', label: `${titleCase(object)} record`, sobject: titleCase(object), expects: [] };
          dataNodes.set(key, node);
          graph.nodes.push(node);
        }
        targetId = node.id;
        // The PORT from the verb (STUDY-DATA-FLOW.md §3.5) — a draft the
        // human confirms in grillme, like every other machine guess here.
        io = verbIo(step.action);
        flags.push(`'${trunc(step.action)}' ${io} the ${titleCase(object)} record (from the verb) — confirm the port`);
      } else {
        scr += 1;
        targetId = `scr_${scr}`;
        graph.nodes.push({ id: targetId, type: 'screen', label: trunc(step.action, 40) });
      }

      const catalog = unique(`${slug(object ?? targetId)}.${verbOf(step.action)}`, usedCatalogs);
      graph.edges.push({
        id: edgeId, from: sessId, to: targetId, type: 'does',
        label: trunc(step.action, 60), data: { catalog, ...(io ? { io, ioDraft: true } : {}) },
      });
      // The step LADDER: a `next` edge from the previous step's target so the
      // canvas reads top-to-bottom like the test case (the walker orders by
      // the does edges; `next` between screens is a reading aid only).
      if (prevTarget && prevTarget !== targetId) {
        graph.edges.push({ id: `e_seq_${edgeSeq}`, from: prevTarget, to: targetId, type: 'next' });
      }
      prevTarget = targetId;

      if (step.expected) {
        const target = graph.nodes.find((n) => n.id === targetId)!;
        target.expects = target.expects ?? [];
        target.expects.push(draftExpect(step, object, edgeId, target.expects, flags));
      }
    }
  });

  graph.nodes.push({ id: 'end', type: 'end', label: '' });
  graph.edges.push({ id: 'e_end', from: prev, to: 'end', type: 'next' });

  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`ado import produced an invalid graph (bug):\n - ${v.errors.join('\n - ')}`);
  return { graph, flags };
}

function draftExpect(step: AdoStep, object: string | undefined, edgeId: string, existing: Expectation[], flags: string[]): Expectation {
  const expected = String(step.expected);
  const id = unique(`check_${slug(trunc(expected, 24)) || edgeId}`, new Set(existing.map((x) => x.id)));
  const base = { id, after: edgeId, draft: true as const, note: 'draft from ADO — confirm once (planner: draft? button)' };
  if (TOAST_RE.test(expected)) {
    const quoted = /["“']([^"”']{2,60})["”']/.exec(expected)?.[1];
    return { ...base, kind: 'ui.toast', value: quoted ?? trunc(expected, 60) };
  }
  if (object && CREATED_RE.test(expected)) {
    return { ...base, kind: 'api.record_exists', target: titleCase(object) };
  }
  if (URL_RE.test(expected)) {
    flags.push(`expected result mentions navigation ('${trunc(expected)}') — drafted ui.url with the raw phrase; set the real path`);
    return { ...base, kind: 'ui.url', value: trunc(expected, 60) };
  }
  return { ...base, kind: 'ui.text', value: trunc(expected, 60) };
}

// ---------- file door ----------

export interface WriteAdoGraphResult extends AdoImportResult {
  graphFile: string;
}

export function writeAdoGraph(result: AdoImportResult, dir = path.resolve('journeys', 'graphs')): WriteAdoGraphResult {
  fs.mkdirSync(dir, { recursive: true });
  let id = result.graph.id;
  let file = path.join(dir, `${id}.graph.json`);
  if (fs.existsSync(file)) {
    id = `${id}_ado`;
    file = path.join(dir, `${id}.graph.json`);
    result = { ...result, graph: { ...result.graph, id }, flags: [...result.flags, `graph '${result.graph.id}' already existed — wrote '${id}' instead`] };
  }
  fs.writeFileSync(file, JSON.stringify(result.graph, null, 2) + '\n');
  return { ...result, graphFile: file };
}

// ---------- small helpers ----------

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!; // 0 <= i < length
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

function cleanAdoHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
}

function titleCase(s: string): string {
  return s.trim().replace(/\s+/g, ' ').split(' ').map((w) => (w[0]?.toUpperCase() ?? '') + w.slice(1)).join('');
}

/** Verb → port: what the action does to the record it names. */
export function verbIo(action: string): DataIo {
  const v = verbOf(action);
  if (/^(add|enter|log)\s+(a\s+|an\s+)?new\b/i.test(action.trim())) return 'produces'; // "add a new address"

  if (/^(create|convert|submit|register|raise|log|new)$/.test(v)) return 'produces';
  if (/^(update|edit|approve|progress|add|delete|remove|change|set|assign|close|reject|cancel)$/.test(v)) return 'updates';
  return 'consumes';
}

function verbOf(action: string): string {
  const w = slug(action.split(/\s+/)[0]);
  return w || 'do';
}

/** The business object in an action phrase — connective words stripped. */
function objectOf(action: string): string | undefined {
  const text = action.replace(/[.!?:;]+\s*$/, '').trim(); // "Verify Prospect Account is Created." — the period hid the object
  const raw = OBJECT_RE.exec(text)?.[1]?.trim();
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/^(?:to|the|a|an|new)\s+/i, '')   // 'approve TO customer' → 'customer'
    .split(/\s+(?:is|was|are|has|have)\b/i)[0]! // split() never returns [] — [0] always exists
    .trim();
  return cleaned || undefined;
}

function unique(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

function trunc(s: string, n = 40): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
