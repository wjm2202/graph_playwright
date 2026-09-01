/**
 * Spec emitter — GRAPH_SPEC=<graph_id> npm run graph:spec
 * Writes tests/e2e/<id>.journey.spec.ts from journeys/graphs/<id>.graph.json.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { writeSpec } from '../../src/graph/toSpec';
import { resolveGraphRef } from '../../src/graph/resolve';
import type { ProcessGraph } from '../../src/graph/schema';

test('emit a standalone journey spec from a process graph', async () => {
  test.skip(!process.env.GRAPH_SPEC, 'set GRAPH_SPEC=<graph_id | project/graph_id>');
  const resolved = resolveGraphRef(String(process.env.GRAPH_SPEC));
  const graph = JSON.parse(fs.readFileSync(resolved.file, 'utf8')) as ProcessGraph;
  const outDir = path.join('tests', 'e2e');
  const rel = path.relative(path.resolve(outDir), resolved.file).split(path.sep).join('/');
  const out = writeSpec(graph, outDir, { graphRef: resolved.ref, graphRelPath: rel });

  console.log(`✔ spec written: ${out} — run it with: npm run test:e2e -- ${out}`);
});
