/**
 * GENERATED from journeys/graphs/lead_to_customer.graph.json — regenerate:
 *   GRAPH_SPEC=lead_to_customer npm run graph:spec
 * Runs the full loop: graph → journey → run (screenshots + oracles) →
 * merge-back, so the plan graph repaints (pass/fail, snapshots) on every run.
 */
import * as path from 'path';
import { test, expect } from '../../src/fixtures/cast';
import { StepCatalog } from '../../src/journeys/catalog';
import { runGraphFile } from '../../src/graph/run';
import { PersonaRegistry } from '../../src/personas/registry';
import { hasOrgConfig } from '../../src/utils/env';

const GRAPH = path.resolve(__dirname, '../../journeys/graphs/lead_to_customer.graph.json');

test('Lead to customer, verified in Siebel', async ({ cast }, testInfo) => {
  test.skip(!hasOrgConfig(), 'SF org env not configured — see SETUP-REAL-ORG.md');
  test.setTimeout(300_000);

  const catalog = new StepCatalog();
  try {
    // Captured vocabulary, when the pipeline has generated it:
     
    const generated = require('../../src/journeys/generated/lead_to_customer.steps');
    const register = generated.registerSteps_lead_to_customer;
    if (typeof register === 'function') register(catalog);
  } catch {
    /* not captured yet — unbound plan.* steps will name what to record */
  }

  const result = await runGraphFile(GRAPH, {
    cast,
    catalog,
    personaIds: PersonaRegistry.load().ids(),
    runDir: testInfo.outputPath('run'),
  });
  for (const change of result.changes) {
     
    console.log('·', change);
  }
  if (result.error) throw result.error;
  expect(result.report.steps.every((s) => s.status !== 'failed')).toBe(true);
});
