#!/usr/bin/env node
/**
 * Inline snapshots → evidence files (sprint 4.2, review §3.2).
 *
 * Merge-back used to embed every screenshot in the graph as a base64 data
 * URL: `lead_to_customer.graph.json` was 91 KB, 79 KB of it six JPEGs, and
 * every repaint produced a diff nobody could read. Merge-back writes files
 * now — this moves the paint already on disk to the same place, so a graph
 * does not have to be re-run to become reviewable.
 *
 *   node tools/migrate-evidence.mjs journeys/graphs/lead_to_customer.graph.json
 *   node tools/migrate-evidence.mjs projects/crm/graphs/*.graph.json
 *   node tools/migrate-evidence.mjs --dry-run journeys/graphs/*.graph.json
 *
 * For each node with a `data:` snapshot ref it writes
 * `<graph root>/evidence/<graphId>/<runId>/<nodeId>.<ext>` and replaces the
 * ref with the relative path (evidence.ts owns the layout rule). The runId is
 * the graph's own — the single runId its `lastResult`s carry — or `migrated`
 * when the graph names none, or more than one.
 *
 * IDEMPOTENT: a ref that is already a path is left exactly as it is, so
 * running this over a whole project twice changes nothing the second time.
 * Nothing else in the document is touched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** evidence.ts's rule, in the one place a plain .mjs can hold it. */
export function graphRootFor(graphFile) {
  const dir = dirname(graphFile);
  return basename(dir) === 'graphs' ? dirname(dir) : dir;
}

const EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

/** `data:image/jpeg;base64,…` → { ext, bytes }, or null for anything else. */
export function decodeDataUrl(ref) {
  const m = /^data:([a-z/+.-]+);base64,(.*)$/is.exec(String(ref ?? ''));
  if (!m) return null;
  const bytes = Buffer.from(m[2], 'base64');
  if (!bytes.length) return null;
  return { ext: EXT[m[1].toLowerCase()] ?? 'bin', bytes };
}

/** The runId this graph's paint already carries, or 'migrated'. */
export function runIdOf(graph) {
  const ids = new Set();
  for (const node of graph.nodes ?? []) {
    for (const x of node.expects ?? []) if (x.lastResult?.runId) ids.add(String(x.lastResult.runId));
  }
  return ids.size === 1 ? [...ids][0] : 'migrated';
}

/**
 * One graph file. Returns what it did — `{ file, moved: [...], skipped }` —
 * and writes nothing when `dryRun` is set or there was nothing inline.
 */
export function migrateGraphFile(graphFile, { dryRun = false } = {}) {
  const text = readFileSync(graphFile, 'utf8');
  const graph = JSON.parse(text);
  const runId = runIdOf(graph);
  const evidenceDir = join(graphRootFor(graphFile), 'evidence', String(graph.id), runId);
  const moved = [];
  let kept = 0;

  for (const node of graph.nodes ?? []) {
    const ref = node.snapshot?.ref;
    if (!ref) continue;
    const decoded = decodeDataUrl(ref);
    if (!decoded) { kept++; continue; }   // already a file ref — idempotent
    const name = `${node.id}.${decoded.ext}`;
    if (!dryRun) {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(join(evidenceDir, name), decoded.bytes);
    }
    node.snapshot.ref = ['evidence', graph.id, runId, name].join('/');
    moved.push({ node: node.id, bytes: decoded.bytes.length, ref: node.snapshot.ref });
  }

  const before = Buffer.byteLength(text);
  let after = before;
  if (moved.length && !dryRun) {
    const out = JSON.stringify(graph, null, 2) + '\n';
    writeFileSync(graphFile, out);
    after = Buffer.byteLength(out);
  }
  return { file: graphFile, runId, evidenceDir, moved, kept, before, after };
}

const isMain = process.argv[1] && process.argv[1].endsWith('migrate-evidence.mjs');
if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const files = args.filter((a) => !a.startsWith('--'));
  if (!files.length) {
    console.error('usage: node tools/migrate-evidence.mjs [--dry-run] <graph.json> [more…]');
    process.exit(2);
  }
  let total = 0;
  for (const file of files) {
    if (!existsSync(file)) { console.error(`✗ no such file: ${file}`); process.exitCode = 1; continue; }
    const r = migrateGraphFile(file, { dryRun });
    total += r.moved.length;
    if (!r.moved.length) { console.log(`· ${file}: nothing inline (${r.kept} file ref(s) already)`); continue; }
    console.log(`✔ ${file}: ${r.moved.length} image(s) → ${r.evidenceDir}${dryRun ? ' (dry run)' : ''}`);
    for (const m of r.moved) console.log(`   · ${m.node} (${Math.round(m.bytes / 1024)}KB) → ${m.ref}`);
    if (!dryRun) console.log(`   graph ${(r.before / 1024).toFixed(0)}KB → ${(r.after / 1024).toFixed(0)}KB`);
  }
  console.log(total ? `${total} image(s) moved${dryRun ? ' (dry run — nothing written)' : ''}` : 'nothing to do');
}
