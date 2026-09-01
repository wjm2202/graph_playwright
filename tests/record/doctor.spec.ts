/**
 * S3 — env doctor CLI:
 *   GRAPH_DOCTOR=lead_to_customer npm run doctor    (one graph)
 *   GRAPH_DOCTOR=all npm run doctor                 (every graph in the library)
 * Prints per-graph readiness + the exact .env lines still missing.
 * Diagnosis only — reads env, never writes anything.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { envDoctor, formatDoctorReport } from '../../src/personas/doctor';
import { listGraphRefs, resolveGraphRef } from '../../src/graph/resolve';
import { PersonaRegistry } from '../../src/personas/registry';
import type { ProcessGraph } from '../../src/graph/schema';

test('diagnose graph runnability from .env', async () => {
  test.skip(!process.env.GRAPH_DOCTOR, 'set GRAPH_DOCTOR=<graph_id | project/graph_id | project:<name> | all>');
  const want = String(process.env.GRAPH_DOCTOR);
  let targets;
  if (want === 'all') {
    targets = listGraphRefs();
    if (!targets.length) throw new Error('no graphs found — create one in the planner or scaffold a project (npm run project:new)');
  } else if (want.startsWith('project:')) {
    const project = want.slice('project:'.length);
    targets = listGraphRefs().filter((r) => r.project === project);
    if (!targets.length) {
      const projects = [...new Set(listGraphRefs().map((r) => r.project).filter(Boolean))];
      throw new Error(`project '${project}' has no graphs — projects with graphs: ${projects.join(', ') || '(none)'}`);
    }
  } else {
    targets = [resolveGraphRef(want)];
  }
  const registry = PersonaRegistry.load();
  let allReady = true;
  for (const target of targets) {
    const graph = JSON.parse(fs.readFileSync(target.file, 'utf8')) as ProcessGraph;
    const report = envDoctor(graph, registry);
    allReady = allReady && report.ready;

    console.log(`\n[${target.ref}]\n` + formatDoctorReport(report));
  }

  if (allReady) console.log('\n✔ everything diagnosed READY — captures and runs will not skip');
});
