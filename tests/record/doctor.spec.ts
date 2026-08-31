/**
 * S3 — env doctor CLI:
 *   GRAPH_DOCTOR=lead_to_customer npm run doctor    (one graph)
 *   GRAPH_DOCTOR=all npm run doctor                 (every graph in the library)
 * Prints per-graph readiness + the exact .env lines still missing.
 * Diagnosis only — reads env, never writes anything.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { envDoctor, formatDoctorReport } from '../../src/personas/doctor';
import { PersonaRegistry } from '../../src/personas/registry';
import type { ProcessGraph } from '../../src/graph/schema';

test('diagnose graph runnability from .env', async () => {
  test.skip(!process.env.GRAPH_DOCTOR, 'set GRAPH_DOCTOR=<graph_id|all>');
  const want = String(process.env.GRAPH_DOCTOR);
  const dir = path.resolve('journeys', 'graphs');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.graph.json'))
    .filter((f) => want === 'all' || f === `${want}.graph.json`);
  if (!files.length) {
    const have = fs.readdirSync(dir).filter((f) => f.endsWith('.graph.json'));
    throw new Error(`no such graph '${want}' — available: ${have.join(', ')} (or 'all')`);
  }
  const registry = PersonaRegistry.load();
  let allReady = true;
  for (const f of files) {
    const graph = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ProcessGraph;
    const report = envDoctor(graph, registry);
    allReady = allReady && report.ready;
     
    console.log('\n' + formatDoctorReport(report));
  }
   
  if (allReady) console.log('\n✔ everything diagnosed READY — captures and runs will not skip');
});
