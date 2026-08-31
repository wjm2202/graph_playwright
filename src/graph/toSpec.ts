/**
 * toSpec — emit a standalone Playwright spec for a process graph. The spec is
 * thin by design (journeys are data): it binds the captured vocabulary when
 * the pipeline has generated it, then runs the full automated loop
 * (plan → journey → run with screenshots + central oracles → merge-back), so
 * simply running the spec keeps the graph's paint current.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProcessGraph } from './schema';
import { validateGraph } from './schema';

export function toSpec(graph: ProcessGraph): string {
  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`cannot emit a spec for an invalid graph:\n - ${v.errors.join('\n - ')}`);
  const id = graph.id;
  const title = (graph.title ?? id).replace(/'/g, "\\'");

  return `/**
 * GENERATED from journeys/graphs/${id}.graph.json — regenerate:
 *   GRAPH_SPEC=${id} npm run graph:spec
 * Runs the full loop: graph → journey → run (screenshots + oracles) →
 * merge-back, so the plan graph repaints (pass/fail, snapshots) on every run.
 */
import * as path from 'path';
import { test, expect } from '../../src/fixtures/cast';
import { StepCatalog } from '../../src/journeys/catalog';
import { runGraphFile } from '../../src/graph/run';
import { PersonaRegistry } from '../../src/personas/registry';
import { hasOrgConfig } from '../../src/utils/env';

const GRAPH = path.resolve(__dirname, '../../journeys/graphs/${id}.graph.json');

test('${title}', async ({ cast }, testInfo) => {
  test.skip(!hasOrgConfig(), 'SF org env not configured — see SETUP-REAL-ORG.md');
  test.setTimeout(300_000);

  const catalog = new StepCatalog();
  try {
    // Captured vocabulary, when the pipeline has generated it:
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const generated = require('../../src/journeys/generated/${id}.steps');
    const register = generated['registerSteps_${id}'];
    if (typeof register === 'function') register(catalog);
  } catch {
    /* not captured yet — unbound plan.* steps will name what to record */
  }

  const registry = PersonaRegistry.load();
  const result = await runGraphFile(GRAPH, {
    cast,
    catalog,
    personaIds: registry.ids(),
    // Cast obeys personas.json; this makes a login_as edge that claims
    // otherwise fail the walk instead of quietly misdocumenting the run.
    personaAuth: registry.authMethods(),
    runDir: testInfo.outputPath('run'),
  });
  for (const change of result.changes) {
    // eslint-disable-next-line no-console
    console.log('·', change);
  }
  if (result.error) throw result.error;
  expect(result.report.steps.every((s) => s.status !== 'failed')).toBe(true);
});
`;
}

/** Write the spec beside the other e2e suites. */
export function writeSpec(graph: ProcessGraph, dir = path.join('tests', 'e2e')): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${graph.id}.journey.spec.ts`);
  fs.writeFileSync(file, toSpec(graph));
  return file;
}
