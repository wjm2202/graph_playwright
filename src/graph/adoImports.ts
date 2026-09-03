/**
 * Test-case imports as a PROJECT asset (owner, 2026-09-02): the exported
 * file is kept verbatim under projects/<p>/imports/ next to a manifest that
 * remembers what it held and which cases became graphs — so the cases you
 * skipped today can be imported tomorrow without re-uploading, and a graph
 * can always be traced back to the row it came from.
 *
 *   projects/<p>/imports/<importId>.<ext>      the file, untouched
 *   projects/<p>/imports/<importId>.json       { id, file, at, sheet, cases[], imported{} }
 *   projects/<p>/graphs/<id>.graph.json        one per imported case (adoCaseToGraph)
 *
 * The planner's dev server calls these; the record-project CLI can too.
 * Pure Node — no planner, no browser.
 */
import * as fs from 'fs';
import * as path from 'path';
import { adoCaseToGraph, writeAdoGraph, type AdoCase } from './fromAdo';
import { parseAdoFile } from './fromAdoXlsx';

export interface ImportedCaseSummary {
  index: number;
  id?: string;
  title: string;
  steps: number;
  /** Set once the case has become a graph. */
  graphId?: string;
  importedAt?: string;
}

export interface ImportManifest {
  id: string;
  /** Basename of the stored file. */
  file: string;
  originalName: string;
  at: string;
  sheet: string;
  cases: ImportedCaseSummary[];
}

const PROJECT_RE = /^[a-z][a-z0-9_-]*$/;

function importsDir(root: string, project: string): string {
  if (!PROJECT_RE.test(project)) throw new Error(`project '${project}' must be lower_snake_case`);
  const dir = path.join(root, 'projects', project);
  if (!fs.existsSync(path.join(dir, 'project.json'))) throw new Error(`project '${project}' does not exist — create it first`);
  return path.join(dir, 'imports');
}

function safeName(name: string): string {
  return path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'import';
}

/** Store the file and parse it. Returns the manifest (cases not yet imported). */
export function storeImport(
  root: string,
  project: string,
  originalName: string,
  data: Buffer | Uint8Array,
  now = new Date(),
): { manifest: ImportManifest; cases: AdoCase[]; skippedSheets: string[] } {
  const dir = importsDir(root, project);
  fs.mkdirSync(dir, { recursive: true });
  const parsed = parseAdoFile(originalName, data); // parse BEFORE storing: a bad file leaves nothing behind
  if (!parsed.cases.length) throw new Error(`'${originalName}' holds no test cases (sheet '${parsed.sheet}')`);
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const ext = path.extname(originalName).toLowerCase() || '.csv';
  const id = `${stamp}-${safeName(path.basename(originalName, path.extname(originalName))).toLowerCase()}`;
  const file = `${id}${ext}`;
  fs.writeFileSync(path.join(dir, file), Buffer.from(data));
  const manifest: ImportManifest = {
    id,
    file,
    originalName: path.basename(originalName),
    at: now.toISOString(),
    sheet: parsed.sheet,
    cases: parsed.cases.map((c, index) => ({ index, ...(c.id ? { id: c.id } : {}), title: c.title, steps: c.steps.length })),
  };
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, cases: parsed.cases, skippedSheets: parsed.skippedSheets };
}

export function listImports(root: string, project: string): ImportManifest[] {
  const dir = importsDir(root, project);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ImportManifest)
    .sort((a, b) => (a.at < b.at ? 1 : -1)); // newest first
}

export function readImport(root: string, project: string, importId: string): { manifest: ImportManifest; cases: AdoCase[] } {
  const dir = importsDir(root, project);
  const file = path.join(dir, `${path.basename(importId)}.json`);
  if (!fs.existsSync(file)) throw new Error(`import '${importId}' not found in project '${project}'`);
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as ImportManifest;
  const parsed = parseAdoFile(manifest.file, fs.readFileSync(path.join(dir, manifest.file)));
  return { manifest, cases: parsed.cases };
}

export interface ApplyResultItem {
  index: number;
  title: string;
  graphId: string;
  graphFile: string;
  nodes: number;
  edges: number;
  flags: string[];
}

/**
 * Turn the chosen cases into draft graphs in projects/<p>/graphs/ and stamp
 * the manifest. Already-imported cases are refused (delete the graph, or
 * pick others) — never a silent second copy.
 */
export function applyImport(
  root: string,
  project: string,
  importId: string,
  indexes: number[],
  opts: { knownPersonas?: string[]; now?: Date } = {},
): { manifest: ImportManifest; results: ApplyResultItem[] } {
  const { manifest, cases } = readImport(root, project, importId);
  const graphsDir = path.join(root, 'projects', project, 'graphs');
  const results: ApplyResultItem[] = [];
  const at = (opts.now ?? new Date()).toISOString();
  const wanted = [...new Set(indexes)].sort((a, b) => a - b);
  for (const index of wanted) {
    const tc = cases[index];
    const summary = manifest.cases[index];
    if (!tc || !summary) throw new Error(`case #${index} is not in import '${importId}' (it holds ${cases.length})`);
    if (summary.graphId) throw new Error(`case #${index} '${summary.title}' was already imported as '${summary.graphId}'`);
  }
  for (const index of wanted) {
    const tc = cases[index]!;
    const summary = manifest.cases[index]!;
    const graphId = graphIdFor(tc, project, graphsDir);
    const drafted = adoCaseToGraph(tc, { graphId, ...(opts.knownPersonas ? { knownPersonas: opts.knownPersonas } : {}) });
    const written = writeAdoGraph(drafted, graphsDir);
    summary.graphId = written.graph.id;
    summary.importedAt = at;
    results.push({
      index, title: tc.title, graphId: written.graph.id, graphFile: written.graphFile,
      nodes: written.graph.nodes.length, edges: written.graph.edges.length, flags: written.flags,
    });
  }
  const dir = importsDir(root, project);
  fs.writeFileSync(path.join(dir, `${manifest.id}.json`), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, results };
}

/** lower_snake_case graph id from the title (ADO id as a tiebreaker), unique in the folder. */
function graphIdFor(tc: AdoCase, _project: string, graphsDir: string): string {
  let base = tc.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 48);
  if (!base) base = `case_${tc.id ?? 'x'}`.replace(/[^a-z0-9_]+/g, '_');
  const taken = (x: string) => fs.existsSync(path.join(graphsDir, `${x}.graph.json`));
  let id = base;
  if (taken(id) && tc.id) id = `${base}_${tc.id.replace(/[^a-z0-9]+/gi, '').toLowerCase()}`; // the ADO id disambiguates
  for (let n = 2; taken(id); n++) id = `${base}_${n}`;
  return id;
}
