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

export interface ToSpecOptions {
  /** Canonical ref (`<project>/<id>`); defaults to the bare id (legacy). */
  graphRef?: string;
  /** Graph path relative to the emitted spec's folder; defaults to the
   *  legacy flat location. Forward slashes. */
  graphRelPath?: string;
}

export function toSpec(graph: ProcessGraph, opts: ToSpecOptions = {}): string {
  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`cannot emit a spec for an invalid graph:\n - ${v.errors.join('\n - ')}`);
  const id = graph.id;
  const ref = opts.graphRef ?? id;
  const rel = opts.graphRelPath ?? `../../journeys/graphs/${id}.graph.json`;
  const title = (graph.title ?? id).replace(/'/g, "\\'");

  return `/**
 * GENERATED from ${rel.replace(/^(\.\.\/)+/, '')} — regenerate:
 *   GRAPH_SPEC=${ref} npm run graph:spec
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

const GRAPH = path.resolve(__dirname, '${rel}');

test('${title}', async ({ cast, request }, testInfo) => {
  test.skip(!hasOrgConfig(), 'SF org env not configured — see SETUP-REAL-ORG.md');
  test.setTimeout(300_000);

  const catalog = new StepCatalog();
  try {
    // Captured vocabulary, when the pipeline has generated it:
    const generated = require('../../src/journeys/generated/${id}.steps') as {
      registerSteps_${id}?: (c: StepCatalog) => StepCatalog;
    };
    const register = generated.registerSteps_${id};
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
`;
}

/** Write the spec beside the other e2e suites. */
export function writeSpec(graph: ProcessGraph, dir = path.join('tests', 'e2e'), opts: ToSpecOptions = {}): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${graph.id}.journey.spec.ts`);
  fs.writeFileSync(file, toSpec(graph, opts));
  return file;
}
