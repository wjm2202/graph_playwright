/**
 * Spec emitter — GRAPH_SPEC=<graph_id> npm run graph:spec
 * Writes tests/e2e/<id>.journey.spec.ts from journeys/graphs/<id>.graph.json.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { writeSpec } from '../../src/graph/toSpec';
import type { ProcessGraph } from '../../src/graph/schema';

test('emit a standalone journey spec from a process graph', async () => {
  test.skip(!process.env.GRAPH_SPEC, 'set GRAPH_SPEC=<graph_id> (see journeys/graphs/)');
  const id = String(process.env.GRAPH_SPEC);
  const file = path.resolve('journeys', 'graphs', `${id}.graph.json`);
  if (!fs.existsSync(file)) {
    const have = fs.readdirSync(path.resolve('journeys', 'graphs')).filter((f) => f.endsWith('.graph.json'));
    throw new Error(`no such graph '${id}' — available: ${have.join(', ')}`);
  }
  const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;
  const out = writeSpec(graph);
   
  console.log(`✔ spec written: ${out} — run it with: npm run test:e2e -- ${out}`);
});
