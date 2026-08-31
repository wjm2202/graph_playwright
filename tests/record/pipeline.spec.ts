/**
 * R7 — the pipeline CLI: recordings/<journey>/ → generated artifacts.
 *
 *   PIPELINE_JOURNEY=expense_v2 npm run pipeline
 *   PIPELINE_ALIASES="submitter=sales_user,approver=admin" (optional)
 *   PIPELINE_CAPABILITY=expense.approve (required for denial captures)
 *
 * Thin shell over tested pieces: readTrace → distill (→ stitch) → generate.
 * Denial captures: evidence extracted from the trace; a captured success
 * refuses to generate. Artifacts land in the real repo dirs for review;
 * the settle-contract batch is NEVER auto-published.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { readTrace } from '../../src/pipeline/traceReader';
import { distill } from '../../src/pipeline/distill';
import { stitchRecordings } from '../../src/pipeline/stitch';
import { extractDenialEvidence } from '../../src/pipeline/denial';
import { generateArtifacts, type GenerateResult } from '../../src/pipeline/generate';
import { planPipeline, type FoundRecording } from '../../src/pipeline/cli';
import { PersonaRegistry } from '../../src/personas/registry';
import type { RecordingManifest } from '../../src/pipeline/recording';
import { emitCaptureGraph } from '../../src/graph/fromCapture';
import type { Distillation } from '../../src/pipeline/distill';
import { recordEvent } from '../../src/telemetry';

test('distill + generate the recorded journey', async () => {
  test.skip(!process.env.PIPELINE_JOURNEY, 'set PIPELINE_JOURNEY to process recordings');

  const journeyId = String(process.env.PIPELINE_JOURNEY);
  const root = path.join('recordings', journeyId);
  const found: FoundRecording[] = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .map((d) => path.join(root, d))
        .filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
        .map((dir) => ({
          dir,
          manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RecordingManifest,
        }))
    : [];

  const plan = planPipeline(journeyId, found, {
    aliases: process.env.PIPELINE_ALIASES,
    capability: process.env.PIPELINE_CAPABILITY,
  });
  const personaIds = PersonaRegistry.load().ids();

  let result: GenerateResult;
  let graphSource: { distillation: Distillation; actors: Record<string, string> } | undefined;
  if (plan.mode === 'deny') {
    const data = readTrace(path.join(plan.recording.dir, plan.recording.manifest.files.trace));
    result = generateArtifacts(distill(data.events), {
      journeyId,
      persona: plan.recording.manifest.persona,
      personaIds,
      deny: { capability: plan.capability, evidence: extractDenialEvidence(data.events) },
    });
  } else if (plan.mode === 'single') {
    const data = readTrace(path.join(plan.recording.dir, plan.recording.manifest.files.trace));
    const distillation = distill(data.events);
    result = generateArtifacts(distillation, {
      journeyId,
      persona: plan.recording.manifest.persona,
      personaIds,
    });
    graphSource = { distillation, actors: { main: plan.recording.manifest.persona } };
  } else {
    const stitched = stitchRecordings(
      plan.recordings.map((r) => {
        const data = readTrace(path.join(r.dir, r.manifest.files.trace));
        return {
          alias: r.alias,
          persona: r.manifest.persona,
          distillation: distill(data.events),
          wallOffsetMs: (data.wallTimeMs ?? 0) - (data.monotonicMs ?? 0),
        };
      }),
    );
    result = generateArtifacts(stitched.distillation, { journeyId, actors: stitched.actors, personaIds });
    graphSource = { distillation: stitched.distillation, actors: stitched.actors };
  }

  recordEvent({ kind: 'pipeline', id: journeyId });
   
  console.log(`\n✔ pipeline (${plan.mode}) for '${journeyId}':`);
  console.log(`  journey:   ${result.journeyFile}`);
  console.log(`  steps:     ${result.stubsFile}`);
  if (result.baselinesFile) console.log(`  baselines: ${result.baselinesFile}`);
  if (result.batchFile) console.log(`  contracts: ${result.batchFile}  (review, then publish via checkpoint — never automatic)`);
  for (const f of result.flags) console.log(`  ⚑ ${f}`);

  // Capture-first graph — on demand (D3), never silently over an authored graph.
  if (process.env.PIPELINE_GRAPH === '1') {
    if (!graphSource) {
      console.log('  ⚑ PIPELINE_GRAPH: denial captures do not emit graphs');
    } else {
      const existing = path.resolve('journeys', 'graphs', `${journeyId}.graph.json`);
      const overwrite = process.env.PIPELINE_GRAPH_OVERWRITE === '1';
      const graphId = fs.existsSync(existing) && !overwrite ? `${journeyId}_captured` : journeyId;
      if (graphId !== journeyId) {
        console.log(`  ⚑ graph '${journeyId}' already exists — writing '${graphId}' (PIPELINE_GRAPH_OVERWRITE=1 to replace)`);
      }
      const g = emitCaptureGraph(graphSource.distillation, {
        graphId, journeyId, actors: graphSource.actors,
      });
      console.log(`  graph:     ${g.graphFile}  (draft oracles — confirm in the planner)`);
      console.log(`  composite: ${g.stepsFile}`);
      for (const f of g.flags) console.log(`  ⚑ ${f}`);
    }
  }
   
});
