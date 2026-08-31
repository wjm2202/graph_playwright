/**
 * R7 fixture-artifact generator — env-gated (GEN_FIXTURE=1). Runs the FULL
 * pipeline over the committed fixture trace and COMMITS the outputs:
 *   journeys/fixture_demo.generated.json
 *   src/journeys/generated/fixture_demo.steps.ts   (typechecked by tsc!)
 *   journeys/baselines/fixture_demo.baselines.json
 *   tests/fixtures/trace-demo/batch-rec-fixture-demo.json (NOT L2/encoding —
 *     fixture contracts are mock evidence and must never reach the substrate)
 * The G1 harness gate (generated-journey.spec.ts) executes these verbatim.
 * Regenerate alongside the fixture trace on Playwright upgrades.
 */
import { test } from '@playwright/test';
import * as path from 'path';
import { readTrace } from '../../src/pipeline/traceReader';
import { distill } from '../../src/pipeline/distill';
import { generateArtifacts } from '../../src/pipeline/generate';
import { PersonaRegistry } from '../../src/personas/registry';

test('generate the committed fixture artifacts', async () => {
  test.skip(!process.env.GEN_FIXTURE, 'artifact generator — run with GEN_FIXTURE=1 on purpose');

  const data = readTrace(path.resolve('tests/fixtures/trace-demo/trace.zip'));
  const result = generateArtifacts(distill(data.events), {
    journeyId: 'fixture_demo',
    persona: 'sales_user',
    personaIds: PersonaRegistry.load().ids(),
    outDirs: { encoding: path.join('tests', 'fixtures', 'trace-demo') },
    today: '2026-08-30',
  });
   
  console.log('committed fixture artifacts:', result.journeyFile, result.stubsFile, result.baselinesFile, result.batchFile);
});
