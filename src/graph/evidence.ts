/**
 * Where a run's screenshots live, and how a graph refers to them.
 *
 * Until sprint 4.2 merge-back inlined every screenshot as a base64 data URL:
 * `lead_to_customer.graph.json` was 91 KB of which 79 KB was six JPEGs, and
 * every repaint produced an unreviewable diff (review §3.2). Evidence is a
 * FILE now, and the graph keeps a short relative ref.
 *
 * ONE rule for both places a graph can live:
 *
 *   the graph's ROOT is its directory, or that directory's parent when the
 *   directory is called `graphs` — so
 *     projects/<p>/graphs/<id>.graph.json  → root projects/<p>/
 *     journeys/graphs/<id>.graph.json      → root journeys/
 *   and evidence lands in `<root>/evidence/<graphId>/<runId>/<nodeId>.jpg`,
 *   stored on the node as the ref `evidence/<graphId>/<runId>/<nodeId>.jpg`
 *   — RELATIVE to that root, so a project folder (or `journeys/`) can be
 *   copied, zipped or handed to another team with its paint intact.
 *
 * A graph sitting loose in a directory of its own (tests, a scratch copy)
 * keeps its evidence beside it — no rule about a parent it does not have.
 *
 * Old graphs whose `snapshot.ref` is still a `data:` URL keep working
 * everywhere (`isDataUrlRef`); they are migrated on the next merge-back, or
 * by `node tools/migrate-evidence.mjs`.
 */

import * as path from 'path';

/** Folder name under the graph root — also the first segment of every ref. */
export const EVIDENCE_DIR = 'evidence';

/** True for the legacy inline form (`data:image/jpeg;base64,…`). */
export function isDataUrlRef(ref: string | undefined): boolean {
  return !!ref && /^data:/i.test(ref);
}

/** The graph's root: its folder, or the parent when that folder is `graphs`. */
export function graphRootFor(graphFile: string): string {
  const dir = path.dirname(path.resolve(graphFile));
  return path.basename(dir) === 'graphs' ? path.dirname(dir) : dir;
}

/** `<root>/evidence` — the only directory a graph's evidence may occupy. */
export function evidenceDirFor(graphFile: string): string {
  return path.join(graphRootFor(graphFile), EVIDENCE_DIR);
}

/** The ref a node stores: `evidence/<graphId>/<runId>/<nodeId>.jpg`. */
export function evidenceRef(graphId: string, runId: string, nodeId: string, dirName = EVIDENCE_DIR): string {
  return [dirName, graphId, runId, `${nodeId}.jpg`].join('/');
}

/**
 * ref → absolute file, or undefined when the ref is inline, empty, or points
 * anywhere but inside this graph's evidence directory. The refusal is the
 * point: a ref is data read off disk, and `../../.env` must not resolve.
 */
export function resolveEvidenceRef(graphFile: string, ref: string | undefined): string | undefined {
  if (!ref || isDataUrlRef(ref)) return undefined;
  const evidenceDir = evidenceDirFor(graphFile);
  const file = path.resolve(graphRootFor(graphFile), ref);
  return file === evidenceDir || file.startsWith(evidenceDir + path.sep) ? file : undefined;
}
