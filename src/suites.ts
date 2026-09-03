/**
 * Suites — the named graph selections `SUITE=<spec>` runs (review §4 #3;
 * goal 7). One generic spec (`tests/e2e/graphs.spec.ts`) asks this module
 * which graphs to register, so adding a graph to a suite is a line of JSON,
 * never a generated spec file.
 *
 * `suites.json` at the repo root:
 *
 *   { "smoke": { "graphs": ["expense_to_siebel", "salesforce/o2a_tc01"] },
 *     "sod":   { "tags": ["sod"] },
 *     "salesforce": { "project": "salesforce" } }
 *
 * A suite's members are the UNION of its three selectors. `SUITE` also takes
 * the selectors directly — `graph:<ref>`, `tag:<t>`, `project:<p>` — and a
 * comma list of any of those and suite names. The result is deduplicated and
 * sorted, so a suite runs in the same order everywhere.
 */

import * as fs from 'fs';
import * as path from 'path';
import { listGraphRefs, loadGraphFile, resolveGraphRef } from './graph/resolve';

export interface SuiteDef {
  /** Explicit members: `<project>/<id>`, or a bare `<id>` (resolved like any ref). */
  graphs?: string[];
  /** Every graph carrying ANY of these `tags`. */
  tags?: string[];
  /** Every graph in this project. */
  project?: string;
}

export type SuitesFile = Record<string, SuiteDef>;

/** The suites file lives at the repo root beside personas.json. */
export const SUITES_FILE = 'suites.json';

/** Read suites.json (absent file = no suites, not an error). Throws on a
 *  malformed document — a suite you cannot trust would silently run nothing. */
export function loadSuites(rootDir = path.resolve('.')): SuitesFile {
  const file = path.join(rootDir, SUITES_FILE);
  if (!fs.existsSync(file)) return {};
  const doc: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${SUITES_FILE}: must be an object of { "<suite>": { graphs?, tags?, project? } }`);
  }
  const out: SuitesFile = {};
  for (const [name, raw] of Object.entries(doc as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${SUITES_FILE}: suite '${name}' must be an object with graphs / tags / project`);
    }
    const def = raw as SuiteDef;
    const strings = (key: 'graphs' | 'tags'): void => {
      const list = def[key];
      if (list === undefined) return;
      if (!Array.isArray(list) || list.some((x) => typeof x !== 'string' || !x)) {
        throw new Error(`${SUITES_FILE}: suite '${name}'.${key} must be an array of non-empty strings`);
      }
    };
    strings('graphs');
    strings('tags');
    if (def.project !== undefined && (typeof def.project !== 'string' || !def.project)) {
      throw new Error(`${SUITES_FILE}: suite '${name}'.project must be a project name`);
    }
    if (def.graphs === undefined && def.tags === undefined && def.project === undefined) {
      throw new Error(`${SUITES_FILE}: suite '${name}' selects nothing — give it graphs, tags or a project`);
    }
    out[name] = def;
  }
  return out;
}

/** Known project names (a project is a folder with a graphs/ dir). */
function projectsWithGraphs(rootDir: string): string[] {
  return [...new Set(listGraphRefs(rootDir).map((r) => r.project).filter((p): p is string => !!p))].sort();
}

/** Refs whose graph carries any of `tags`. Every graph is read (and
 *  validated) on the way — an unreadable graph is a loud failure, not a
 *  quietly missing suite member. */
function refsWithTags(tags: string[], rootDir: string): string[] {
  const wanted = new Set(tags);
  return listGraphRefs(rootDir)
    .filter((r) => (loadGraphFile(r.file).tags ?? []).some((t) => wanted.has(t)))
    .map((r) => r.ref);
}

function refsInProject(project: string, rootDir: string): string[] {
  const known = projectsWithGraphs(rootDir);
  if (!known.includes(project)) {
    throw new Error(`no such project '${project}' — available: ${known.length ? known.join(', ') : '(none)'}`);
  }
  return listGraphRefs(rootDir).filter((r) => r.project === project).map((r) => r.ref);
}

/** The members of one named suite (the union of its selectors). */
export function suiteMembers(name: string, rootDir = path.resolve('.')): string[] {
  const suites = loadSuites(rootDir);
  const def = suites[name];
  if (!def) {
    const names = Object.keys(suites).sort();
    throw new Error(
      `no such suite '${name}' — available: ${names.length ? names.join(', ') : `(none defined in ${SUITES_FILE})`}` +
        ` · or select directly with graph:<ref> | tag:<t> | project:<p>`,
    );
  }
  const out = new Set<string>();
  for (const g of def.graphs ?? []) out.add(resolveGraphRef(g, rootDir).ref);
  for (const ref of def.tags?.length ? refsWithTags(def.tags, rootDir) : []) out.add(ref);
  if (def.project !== undefined) for (const ref of refsInProject(def.project, rootDir)) out.add(ref);
  return [...out].sort();
}

/**
 * Resolve a `SUITE` spec to canonical graph refs, sorted and deduplicated.
 * Terms: a suite name, `graph:<ref>`, `tag:<t>`, `project:<p>`, or a comma
 * list of any of those. Anything that cannot be resolved throws naming what
 * IS available — a typo must never look like "nothing to run".
 */
export function selectGraphs(spec: string, rootDir = path.resolve('.')): string[] {
  const terms = spec.split(',').map((t) => t.trim()).filter(Boolean);
  if (!terms.length) {
    throw new Error(`SUITE is empty — name a suite from ${SUITES_FILE}, or select with graph:<ref> | tag:<t> | project:<p>`);
  }
  const out = new Set<string>();
  for (const term of terms) {
    if (term.startsWith('graph:')) out.add(resolveGraphRef(term.slice('graph:'.length), rootDir).ref);
    // A tag nothing carries yet selects nothing on purpose: tags are free
    // labels, so there is no roster to check the spelling against.
    else if (term.startsWith('tag:')) for (const ref of refsWithTags([term.slice('tag:'.length)], rootDir)) out.add(ref);
    else if (term.startsWith('project:')) for (const ref of refsInProject(term.slice('project:'.length), rootDir)) out.add(ref);
    else for (const ref of suiteMembers(term, rootDir)) out.add(ref);
  }
  return [...out].sort();
}
