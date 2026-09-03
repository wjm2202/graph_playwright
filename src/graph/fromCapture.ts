/**
 * S2 — capture-first v2: ONE recording → the compact plan graph a human
 * would have drawn, plus a composite steps module that makes it replayable.
 *
 * Collapse rules (deterministic):
 *  - consecutive steps by the same actor form a SEGMENT → one session node;
 *  - inside a segment, each save-ish step (modal.save, or a click whose name
 *    reads like save/submit/confirm/done/next/finish) CLOSES a group → one
 *    `does` edge carrying the captured micro-step indexes as provenance;
 *  - a group that touched an SObject (record page opened, or a harvested
 *    record id in its args) lands on a DATA node for that object — with
 *    DRAFTED oracles (`draft: true`): api.record_exists + ui.url. Toast text
 *    is not in traces, so we never guess it — confirm-once, same idiom as the
 *    data dictionary;
 *  - sessions chain with login_as, the last session runs `next` → end.
 *
 * The composite module registers each edge's catalog name to replay its
 * slice of the GENERATED journey via runJourneySlice — capture once, human
 * names nothing, and `runGraph` closes the loop end to end.
 */
import * as fs from 'fs';
import * as path from 'path';
import { mentionsRecord, type Distillation, type DistilledStep } from '../pipeline/distill';
import { validateGraph, type Expectation, type PEdge, type PNode, type ProcessGraph, type SystemDef } from './schema';
import { asText } from '../utils/text';

const SAVEISH_RE = /^(save|submit|confirm|done|next|finish)/i;
const NAV_CATALOGS = new Set(['nav.goto', 'recordPage.open', 'recordPage.landed']);

export interface FromCaptureOptions {
  graphId: string;
  /** The generated journey this capture distilled into (provenance + replay). */
  journeyId: string;
  /** alias → personas.json id (single recordings: { main: persona }). */
  actors: Record<string, string>;
  systems?: Record<string, SystemDef>;
  /** URL origin → system key, e.g. { 'https://uat.my.salesforce.com': 'sf' }. */
  systemByOrigin?: Record<string, string>;
  title?: string;
}

export interface CaptureGraphResult {
  graph: ProcessGraph;
  flags: string[];
}

interface Group {
  alias: string;
  indexes: number[];
  steps: DistilledStep[];
  boundary?: DistilledStep;
}

export function compactFromDistillation(d: Distillation, opts: FromCaptureOptions): CaptureGraphResult {
  const flags: string[] = [];
  const systems = opts.systems ?? { sf: { label: 'Salesforce', kind: 'salesforce' } };
  const defaultSystem = Object.keys(systems)[0] ?? 'sf'; // systems defaults above — never empty

  const graph: ProcessGraph = {
    schema: 'process-graph/2',
    id: opts.graphId,
    ...(opts.title ? { title: opts.title } : {}),
    systems,
    actors: opts.actors,
    nodes: [{ id: 'start', type: 'start', label: '' }],
    edges: [],
  };

  // ---- segments by actor, groups by save-ish boundaries -------------------
  const soleAlias = Object.keys(opts.actors)[0] ?? 'main';
  const segments: { alias: string; groups: Group[]; steps: { s: DistilledStep; i: number }[] }[] = [];
  d.steps.forEach((s, i) => {
    const alias = s.actorAlias ?? soleAlias;
    let seg = segments[segments.length - 1];
    if (seg?.alias !== alias) {
      seg = { alias, groups: [], steps: [] };
      segments.push(seg);
    }
    seg.steps.push({ s, i });
    let g = seg.groups[seg.groups.length - 1];
    if (!g || g.boundary) {
      g = { alias, indexes: [], steps: [] };
      seg.groups.push(g);
    }
    g.indexes.push(i);
    g.steps.push(s);
    if (isSaveish(s)) g.boundary = s;
  });

  // Post-save redirects fold back in: a boundary-less group of pure
  // navigation (Save → Lightning redirects to the new record) belongs to the
  // save that caused it — that nav also carries the SObject signal.
  for (const seg of segments) {
    for (let j = seg.groups.length - 1; j > 0; j--) {
      const g = seg.groups[j];
      const prev = seg.groups[j - 1];
      if (g && prev && !g.boundary && g.steps.every((s) => NAV_CATALOGS.has(s.catalog))) {
        prev.indexes.push(...g.indexes);
        prev.steps.push(...g.steps);
        seg.groups.splice(j, 1);
      }
    }
  }

  // ---- nodes + edges ------------------------------------------------------
  const usedCatalogs = new Set<string>();
  const dataNodes = new Map<string, PNode>(); // sobject(lower) → node
  const groupTarget = new Map<Group, string>();
  let prevSessionId = 'start';
  let screenSeq = 0;

  segments.forEach((seg, segIdx) => {
    const sessId = `sess_${seg.alias}${countAlias(segments, segIdx, seg.alias) > 0 ? `_${countAlias(segments, segIdx, seg.alias) + 1}` : ''}`;
    const sysKey = segmentSystem(seg.steps.map((x) => x.s), opts.systemByOrigin, defaultSystem);
    const first = seg.steps[0]!.s; // segments are created BY their first step — never empty
    const last = seg.steps[seg.steps.length - 1]!.s;
    const session: PNode = {
      id: sessId,
      type: 'session',
      label: `${systems[sysKey]?.label ?? sysKey} · ${seg.alias}`,
      system: sysKey,
      actor: seg.alias,
      steps: { status: 'captured', journeyId: opts.journeyId, stepIndexes: seg.steps.map((x) => x.i) },
      timing: { capturedMeanMs: Math.max(0, Math.round(last.endMs - first.startMs)) },
      ...(() => { const u = firstUrl(seg.steps.map((x) => x.s)); return u ? { url: u } : {}; })(),
    };
    graph.nodes.push(session);
    graph.edges.push({
      id: `e_login_${segIdx + 1}`,
      from: prevSessionId,
      to: sessId,
      type: 'login_as',
    });
    prevSessionId = sessId;

    seg.groups.forEach((g, k) => {
      const sobject = groupSObject(g, d);
      const catalog = uniqueName(catalogNameFor(g, sobject, seg.alias, k), usedCatalogs);
      const edgeId = `e_do_${segIdx + 1}_${k + 1}`;

      let targetId: string;
      let io: 'produces' | 'consumes' | 'updates' | undefined;
      if (sobject) {
        const key = sobject.toLowerCase();
        let node = dataNodes.get(key);
        if (!node) {
          node = { id: key, type: 'data', label: `${sobject} record`, sobject, expects: [] };
          dataNodes.set(key, node);
          graph.nodes.push(node);
        }
        node.expects!.push(...draftExpects(sobject, edgeId, node.expects!));
        targetId = node.id;
        // The PORT (STUDY-DATA-FLOW.md §3.4): the group holding the record's
        // defining save PRODUCES it; a later group that saves again UPDATES;
        // anything else merely CONSUMES. A record nobody created is external.
        const port = portFor(g, d, sobject);
        io = port.io;
        if (port.external && !node.external) {
          node.external = true;
          flags.push(`${catalog}: ${sobject} record pre-existed in the capture — seed it or find it by name (node '${node.id}' external: true)`);
        }
      } else {
        screenSeq += 1;
        targetId = `scr_${seg.alias}_${screenSeq}`;
        graph.nodes.push({
          id: targetId,
          type: 'screen',
          label: g.boundary ? stepName(g.boundary) : 'working screen',
        });
      }
      groupTarget.set(g, targetId);

      const rawIdx = g.steps.filter((s) => s.kind === 'raw').length;
      if (rawIdx > 0) {
        flags.push(`${catalog}: ${rawIdx} unnamed raw step(s) inside — name them in the generated steps file before replay`);
      }
      graph.edges.push({
        id: edgeId,
        from: sessId,
        to: targetId,
        type: 'does',
        label: labelFor(catalog, g),
        data: {
          catalog,
          stepIndexes: g.indexes,
          meanMs: Math.max(0, Math.round(g.steps.reduce((a, s) => a + s.durationMs, 0))),
          ...(io ? { io } : {}),
        },
      } as PEdge);
    });
  });

  graph.nodes.push({ id: 'end', type: 'end', label: '' });
  graph.edges.push({ id: 'e_end', from: prevSessionId, to: 'end', type: 'next' });

  // ---- cross-actor record handoffs ---------------------------------------
  let h = 0;
  for (const rec of d.harvestedIds) {
    const touching: Group[] = [];
    for (const seg of segments) {
      for (const g of seg.groups) {
        if (g.steps.some((s) => mentionsRecord(s, rec))) touching.push(g);
      }
    }
    for (let k = 1; k < touching.length; k++) {
      const prevT = touching[k - 1]!; // 1 <= k < length — both ends exist
      const curT = touching[k]!;
      if (prevT.alias !== curT.alias) {
        const from = groupTarget.get(prevT)!;
        const to = groupTarget.get(curT)!;
        if (from !== to) {
          h += 1;
          graph.edges.push({ id: `e_hand_${h}`, from, to, type: 'handoff', label: 'record handoff', data: { recordRef: rec.id } });
        }
      }
    }
  }

  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`compactFromDistillation produced an invalid graph (bug):\n - ${v.errors.join('\n - ')}`);
  return { graph, flags };
}

// ---- composite steps module ----------------------------------------------

/** Source of src/journeys/generated/<graphId>.steps.ts — replayable does edges. */
export function graphStepsModuleSource(graph: ProcessGraph, journeyId: string): string {
  const does = graph.edges.filter(
    (e): e is PEdge & { data: { catalog: string; stepIndexes: number[] } } =>
      e.type === 'does' && typeof e.data?.catalog === 'string' && Array.isArray((e.data as { stepIndexes?: unknown }).stepIndexes),
  );
  const lines: string[] = [
    '/**',
    ` * GENERATED capture-first composite steps for graph '${graph.id}'.`,
    ` * Each does edge replays its recorded micro-step slice of journey`,
    ` * '${journeyId}' through the vocabulary catalog — regenerate, never hand-edit.`,
    ' */',
    "import * as path from 'path';",
    "import { StepCatalog } from '../catalog';",
    "import { runJourneySlice } from '../slice';",
    `import { registerSteps_${journeyId} } from './${journeyId}.steps';`,
    '',
    `const VOCAB = registerSteps_${journeyId}(new StepCatalog());`,
    `const JOURNEY = path.resolve(__dirname, '../../../journeys/generated/${journeyId}.generated.json');`,
    '',
    `export function registerSteps_${graph.id}(catalog: StepCatalog): StepCatalog {`,
    '  return catalog',
  ];
  does.forEach((e, i) => {
    const end = i === does.length - 1 ? ';' : '';
    lines.push(`    .register('${e.data.catalog}', (ctx) => runJourneySlice(ctx, VOCAB, JOURNEY, [${e.data.stepIndexes.join(', ')}]))${end}`);
  });
  if (does.length === 0) lines.push('    ;');
  lines.push('}', '');
  return lines.join('\n');
}

export interface EmitCaptureGraphResult extends CaptureGraphResult {
  graphFile: string;
  stepsFile: string;
}

/** Write graph JSON + composite steps module into the repo (capture-first, on demand). */
export function emitCaptureGraph(
  d: Distillation,
  opts: FromCaptureOptions,
  dirs: { graphs?: string; generated?: string } = {},
): EmitCaptureGraphResult {
  const { graph, flags } = compactFromDistillation(d, opts);
  const graphsDir = dirs.graphs ?? path.resolve('journeys', 'graphs');
  const genDir = dirs.generated ?? path.resolve('src', 'journeys', 'generated');
  fs.mkdirSync(graphsDir, { recursive: true });
  fs.mkdirSync(genDir, { recursive: true });
  const graphFile = path.join(graphsDir, `${graph.id}.graph.json`);
  const stepsFile = path.join(genDir, `${graph.id}.steps.ts`);
  fs.writeFileSync(graphFile, JSON.stringify(graph, null, 2) + '\n');
  fs.writeFileSync(stepsFile, graphStepsModuleSource(graph, opts.journeyId));
  return { graph, flags, graphFile, stepsFile };
}

// ---- helpers --------------------------------------------------------------

function isSaveish(s: DistilledStep): boolean {
  if (s.catalog === 'modal.save') return true;
  if (s.catalog === 'ui.click') return SAVEISH_RE.test(stepName(s));
  return false;
}

function stepName(s: DistilledStep): string {
  const a = s.args;
  return asText(a.button ?? a.name ?? a.label ?? a.text ?? a.testId);
}

function firstUrl(steps: DistilledStep[]): string | undefined {
  for (const s of steps) if (typeof s.args.url === 'string') return s.args.url;
  return undefined;
}

function segmentSystem(
  steps: DistilledStep[],
  byOrigin: Record<string, string> | undefined,
  fallback: string,
): string {
  if (byOrigin) {
    for (const s of steps) {
      const url = typeof s.args.url === 'string' ? s.args.url : undefined;
      if (!url) continue;
      try {
        const mapped = byOrigin[new URL(url).origin];
        if (mapped) return mapped;
      } catch { /* relative url — keep looking */ }
    }
  }
  return fallback;
}

/** Which way the data flows between this group and its SObject's record. */
function portFor(
  g: Group,
  d: Distillation,
  sobject: string,
): { io: 'produces' | 'consumes' | 'updates'; external: boolean; handle?: string } {
  const recs = d.harvestedIds.filter((r) => r.sobject === sobject && g.steps.some((s) => mentionsRecord(s, r)));
  const defines = recs.find((r) => r.defStep !== undefined && g.indexes.includes(r.defStep));
  if (defines) return { io: 'produces', external: false, ...(defines.handle ? { handle: defines.handle } : {}) };
  const first = recs[0];
  const external = recs.length > 0 && recs.every((r) => r.origin === 'external' || r.defStep === undefined);
  const handle = first?.handle;
  // No harvested record at all (SObject known only from the opened list/page):
  // a save here creates one.
  if (!recs.length) return { io: g.boundary ? 'produces' : 'consumes', external: false };
  return { io: g.boundary ? 'updates' : 'consumes', external, ...(handle ? { handle } : {}) };
}

function groupSObject(g: Group, d: Distillation): string | undefined {
  for (const s of g.steps) {
    if ((s.catalog === 'recordPage.open' || s.catalog === 'recordPage.landed') && typeof s.args.sobject === 'string') return s.args.sobject;
  }
  for (const rec of d.harvestedIds) {
    if (!rec.sobject) continue;
    if (g.steps.some((s) => mentionsRecord(s, rec))) return rec.sobject;
  }
  return undefined;
}

function catalogNameFor(g: Group, sobject: string | undefined, alias: string, k: number): string {
  const verb = g.boundary ? slug(stepName(g.boundary)) || 'save' : 'work';
  if (sobject) return `${sobject.toLowerCase()}.${verb}`;
  return `${alias}.part_${k + 1}`;
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let n = 2;
  while (used.has(name)) name = `${base}_${n++}`;
  used.add(name);
  return name;
}

function labelFor(catalog: string, g: Group): string {
  const fills = g.steps.filter((s) => s.catalog === 'form.fill' || s.catalog === 'combobox.select').length;
  return fills > 0 ? `${catalog} (${fills} field${fills === 1 ? '' : 's'})` : catalog;
}

function draftExpects(sobject: string, edgeId: string, existing: Expectation[]): Expectation[] {
  const have = new Set(existing.map((x) => x.id));
  const mk = (id: string, x: Omit<Expectation, 'id'>): Expectation[] =>
    have.has(id) ? [] : [{ id, ...x, draft: true, after: edgeId, note: 'draft from capture — confirm once (planner: untick draft)' }];
  return [
    ...mk(`${sobject.toLowerCase()}_exists`, { kind: 'api.record_exists', target: sobject }),
    ...mk(`${sobject.toLowerCase()}_page`, { kind: 'ui.url', value: `/lightning/r/${sobject}/` }),
  ];
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24);
}

function countAlias(segments: { alias: string }[], upto: number, alias: string): number {
  let c = 0;
  for (let i = 0; i < upto; i++) if (segments[i]?.alias === alias) c += 1;
  return c;
}
