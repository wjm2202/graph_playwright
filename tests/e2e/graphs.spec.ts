/**
 * The suite runner — ONE spec for every graph (review §4 #3, goal 7).
 *
 *   sfpw suite smoke                      # suites.json
 *   sfpw suite graph:crm/create_customer
 *   sfpw suite tag:sod,project:salesforce
 *
 * (`sfpw suite` sets SUITE= and runs this project; the env var is the
 * handover between the CLI and Playwright, not a user interface.)
 *
 * `selectGraphs` resolves the spec to canonical refs and `expandVariants`
 * turns each graph's persona matrix into bindings, so a graph joins the run
 * by being tagged or listed in suites.json — never by generating a spec file.
 * Each test runs the full loop (graph → journey → run with screenshots +
 * oracles → merge-back), so the graph on disk repaints on every run.
 */
import * as fs from 'fs';
import * as path from 'path';
import { test, expect } from '../../src/fixtures/cast';
import { SalesforceApi } from '../../src/api/salesforceApi';
import { StepCatalog } from '../../src/journeys/catalog';
import { salesforceApiOracle } from '../../src/journeys/salesforceOracle';
import { runGraphFile } from '../../src/graph/run';
import { loadGraphFile, resolveGraphRef } from '../../src/graph/resolve';
import { expandVariants } from '../../src/graph/toJourney';
import { selectGraphs } from '../../src/suites';
import { PersonaRegistry } from '../../src/personas/registry';
import { hasOrgConfig, loadEnv } from '../../src/utils/env';
import { guideAnnotation } from '../../src/studio/slug';
import { buildVideoTimeline } from '../../src/studio/video';
import type { StepReport } from '../../src/journeys/runner';

const ROOT = path.resolve(__dirname, '../..');
const SUITE = process.env.SUITE ?? 'smoke';

/**
 * Captured vocabulary, when the pipeline has generated it. A missing module
 * is the normal "not recorded yet" state; anything else (a syntax error in
 * generated code, a missing import inside it) is a real failure and must not
 * be swallowed — that is what turns a broken capture into a silent no-op.
 */
function bindCapturedSteps(catalog: StepCatalog, graphId: string): void {
  const moduleId = `../../src/journeys/generated/${graphId}.steps`;
  let mod: Record<string, unknown>;
  try {
    mod = require(moduleId) as Record<string, unknown>;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(`${graphId}.steps`)) return;
    throw e;
  }
  const register = mod[`registerSteps_${graphId}`];
  if (typeof register === 'function') (register as (c: StepCatalog) => StepCatalog)(catalog);
}

for (const ref of selectGraphs(SUITE, ROOT)) {
  const graphFile = resolveGraphRef(ref, ROOT).file;
  const graph = loadGraphFile(graphFile);
  // The persona matrix (graph.alternatives) expands to one test per binding,
  // default first — same walk, different actors (docs/GRAPH-SPEC.md §3.3).
  for (const variant of expandVariants(graph)) {
    const title = variant.id === 'default' ? ref : `${ref} · as ${variant.label}`;

    test(title, async ({ cast, request }, testInfo) => {
      test.skip(!hasOrgConfig(), 'SF org env not configured — see SETUP-REAL-ORG.md');
      test.setTimeout(300_000);
      // Journey Studio reads this out of results.json to name the guide and
      // build its deep link (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §3.1).
      // Pushed before the walk so a failed run is annotated too.
      testInfo.annotations.push(guideAnnotation(ref, variant, graph));

      const catalog = new StepCatalog();
      bindCapturedSteps(catalog, graph.id);

      const registry = PersonaRegistry.load();

      // Backend oracles (api.record_exists / api.field_equals) assert
      // PERSISTENCE through the REST API, fenced to E2E_-named test data.
      // Binding needs SF_ACCESS_TOKEN (UI creds alone cannot query) — without
      // it every backend check reports 'skipped' with the reason, never a
      // silent pass. Default scope is THIS run's records (E2E_<runId>%;
      // strays from earlier runs can never green a check) — ORACLE_SCOPE=suite
      // widens to any E2E_ record for captures that type literal names.
      const env = loadEnv();
      const apiOracle = env?.accessToken
        ? salesforceApiOracle(new SalesforceApi(request, env.instanceUrl, env.accessToken, env.apiVersion), {
            scope: process.env.ORACLE_SCOPE === 'suite' ? 'suite' : 'run',
          })
        : undefined;

      const runDir = testInfo.outputPath('run');
      let result;
      try {
        result = await runGraphFile(graphFile, {
          cast,
          catalog,
          personaIds: registry.ids(),
          // Cast obeys personas.json; this makes a login_as edge that claims
          // otherwise fail the walk instead of quietly misdocumenting the run.
          personaAuth: registry.authMethods(),
          runDir,
          ...(apiOracle ? { apiOracle } : {}),
          ...(variant.id === 'default' ? {} : { actorOverrides: variant.actors, variant: variant.id }),
        });
      } finally {
        // The per-node run report rides along in results.json as an
        // attachment so Journey Studio (or anything else reading the report)
        // can show node-level pass/fail next to the video. Best-effort: a
        // walk that died before writing report.json must not mask its own
        // error with an attach failure.
        const reportPath = path.join(runDir, 'report.json');
        if (fs.existsSync(reportPath)) {
          await testInfo.attach('graph-run', { path: reportPath, contentType: 'application/json' });
          // Stitching contract: which persona's screen to show when. Video
          // paths are known now (Playwright names them at page creation);
          // the cast fixture attaches the files themselves after teardown.
          const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as { steps?: StepReport[] };
          const timeline = buildVideoTimeline(await cast.videoManifest(), report.steps ?? []);
          if (timeline.videos.length) {
            await testInfo.attach('video-timeline', { body: JSON.stringify(timeline), contentType: 'application/json' });
          }
        }
      }
      for (const change of result.changes) {
        console.log('·', change);
      }
      if (result.error) throw result.error;
      expect(result.report.steps.every((s) => s.status !== 'failed')).toBe(true);
    });
  }
}
