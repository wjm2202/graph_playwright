/**
 * Reading and writing graph documents from the CLI.
 *
 * Deliberately NOT `loadGraphFile` (src/graph/resolve.ts): that validates,
 * and half of what the CLI does is work on graphs that are not valid yet —
 * an ADO draft, a half-authored graph you are about to grill. The commands
 * that DO need a validated graph (the runner, suites) go through the load
 * door as before.
 */
import * as fs from 'fs';
import { normalizeGraph, type ProcessGraph } from '../graph/schema';

export function readGraph(file: string): ProcessGraph {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;
  // Not validation — the pre-4.4 data-flow fields (origin / ref / data.bind)
  // are simply mapped forward so an old file still opens. Warnings go to
  // stderr so `--json` on stdout stays exactly one JSON document.
  const { graph, warnings } = normalizeGraph(doc);
  for (const w of warnings) console.warn(`graph '${file}': ${w}`);
  return graph;
}

/** Same shape every writer in this repo produces: 2-space JSON, trailing newline. */
export function writeGraph(file: string, graph: ProcessGraph): void {
  fs.writeFileSync(file, JSON.stringify(graph, null, 2) + '\n');
}
