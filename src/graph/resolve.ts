/**
 * Graph reference resolution (DESIGN-PROJECTS.md §3.2).
 *
 * A graph ref is `<project>/<graph_id>` — resolved against
 * `projects/<project>/graphs/<graph_id>.graph.json` — or a bare `<graph_id>`,
 * which searches every project PLUS the legacy flat `journeys/graphs/`
 * folder: a unique match proceeds, ambiguity errors listing every candidate
 * ref, absence errors listing everything available. Projects are discovered
 * by scanning the filesystem — nothing enumerates project names in code.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface ResolvedGraph {
  /** Absolute path to the .graph.json file. */
  file: string;
  /** Owning project, or undefined for the legacy flat folder. */
  project?: string;
  /** Canonical ref (`<project>/<id>` or bare `<id>` for legacy). */
  ref: string;
  id: string;
}

const LEGACY_DIR = ['journeys', 'graphs'] as const;

function projectsDir(rootDir: string): string {
  return path.join(rootDir, 'projects');
}

function graphFile(rootDir: string, project: string | undefined, id: string): string {
  return project
    ? path.join(projectsDir(rootDir), project, 'graphs', `${id}.graph.json`)
    : path.join(rootDir, ...LEGACY_DIR, `${id}.graph.json`);
}

function projectNames(rootDir: string): string[] {
  const base = projectsDir(rootDir);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'graphs')))
    .map((d) => d.name)
    .sort();
}

/** Every known ref — legacy graphs as bare ids, project graphs as p/id. */
export function listGraphRefs(rootDir = path.resolve('.')): ResolvedGraph[] {
  const out: ResolvedGraph[] = [];
  const legacyDir = path.join(rootDir, ...LEGACY_DIR);
  if (fs.existsSync(legacyDir)) {
    for (const f of fs.readdirSync(legacyDir).filter((x) => x.endsWith('.graph.json')).sort()) {
      const id = f.replace(/\.graph\.json$/, '');
      out.push({ file: path.join(legacyDir, f), ref: id, id });
    }
  }
  for (const project of projectNames(rootDir)) {
    const dir = path.join(projectsDir(rootDir), project, 'graphs');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.graph.json')).sort()) {
      const id = f.replace(/\.graph\.json$/, '');
      out.push({ file: path.join(dir, f), project, ref: `${project}/${id}`, id });
    }
  }
  return out;
}

/** Resolve a ref or bare id; throws with the available refs on any miss. */
export function resolveGraphRef(ref: string, rootDir = path.resolve('.')): ResolvedGraph {
  const available = (): string => {
    const refs = listGraphRefs(rootDir).map((r) => r.ref);
    return refs.length ? refs.join(', ') : '(no graphs found)';
  };

  if (ref.includes('/')) {
    const at = ref.indexOf('/');
    const project = ref.slice(0, at);
    const id = ref.slice(at + 1);
    const file = graphFile(rootDir, project, id);
    if (!fs.existsSync(file)) {
      throw new Error(`no such graph '${ref}' — available: ${available()}`);
    }
    return { file, project, ref: `${project}/${id}`, id };
  }

  const matches = listGraphRefs(rootDir).filter((r) => r.id === ref);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) throw new Error(`no such graph '${ref}' — available: ${available()}`);
  throw new Error(
    `graph id '${ref}' exists in more than one place — say which: ${matches.map((m) => m.ref).join(', ')}`,
  );
}
