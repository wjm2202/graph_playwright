/**
 * GENERATED from journeys/graphs/lead_to_customer.graph.json — regenerate:
 *   GRAPH_SPEC=lead_to_customer npm run graph:spec
 * Runs the full loop: graph → journey → run (screenshots + oracles) →
 * merge-back, so the plan graph repaints (pass/fail, snapshots) on every run.
 */
import * as path from 'path';
import { test, expect } from '../../src/fixtures/cast';
import { SalesforceApi } from '../../src/api/salesforceApi';
import { StepCatalog } from '../../src/journeys/catalog';
import { salesforceApiOracle } from '../../src/journeys/salesforceOracle';
import { runGraphFile } from '../../src/graph/run';
import { PersonaRegistry } from '../../src/personas/registry';
import { hasOrgConfig, loadEnv } from '../../src/utils/env';

const GRAPH = path.resolve(__dirname, '../../journeys/graphs/lead_to_customer.graph.json');

test('Lead to customer, verified in Siebel', async ({ cast, request }, testInfo) => {
  test.skip(!hasOrgConfig(), 'SF org env not configured — see SETUP-REAL-ORG.md');
  test.setTimeout(300_000);

  const catalog = new StepCatalog();
  try {
    // Captured vocabulary, when the pipeline has generated it:
    const generated = require('../../src/journeys/generated/lead_to_customer.steps') as {
      registerSteps_lead_to_customer?: (c: StepCatalog) => StepCatalog;
    };
    const register = generated.registerSteps_lead_to_customer;
    if (typeof register === 'function') register(catalog);
  } catch {
    /* not captured yet — unbound plan.* steps will name what to record */
  }

  const registry = PersonaRegistry.load();

  // Backend oracles (api.record_exists / api.field_equals) assert PERSISTENCE
  // through the REST API, fenced to E2E_-named test data. Binding needs
  // SF_ACCESS_TOKEN (UI creds alone cannot query) — without it every backend
  // check reports 'skipped' with the reason, never a silent pass. Default
  // scope is THIS run's records (E2E_<runId>%; strays from earlier runs can
  // never green a check) — ORACLE_SCOPE=suite widens to any E2E_ record for
  // captures that type literal names.
  const env = loadEnv();
  const apiOracle = env?.accessToken
    ? salesforceApiOracle(new SalesforceApi(request, env.instanceUrl, env.accessToken, env.apiVersion), {
        scope: process.env.ORACLE_SCOPE === 'suite' ? 'suite' : 'run',
      })
    : undefined;

  const result = await runGraphFile(GRAPH, {
    cast,
    catalog,
    personaIds: registry.ids(),
    // Cast obeys personas.json; this makes a login_as edge that claims
    // otherwise fail the walk instead of quietly misdocumenting the run.
    personaAuth: registry.authMethods(),
    runDir: testInfo.outputPath('run'),
    ...(apiOracle ? { apiOracle } : {}),
  });
  for (const change of result.changes) {
    console.log('·', change);
  }
  if (result.error) throw result.error;
  expect(result.report.steps.every((s) => s.status !== 'failed')).toBe(true);
});
