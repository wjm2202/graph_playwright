/**
 * Simulated-run CLI — paint a graph green WITHOUT an org:
 *   npx sfpw simulate <graph_id>          (sets SIMULATE= and runs this spec)
 *
 * Renders one labeled "SIMULATED" evidence card (jpeg) per step, fabricates a
 * passing report, and merges it through the REAL merge-back (same paint a
 * green run produces, stamped with a sim_ runId). Also writes the simulated
 * generated-steps module — refusing to clobber a real pipeline module unless
 * SIMULATE_OVERWRITE=1. Labour telemetry is deliberately NOT written:
 * scaffold→first-green stats must only reflect real capture work.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  simulateReport, simulateRun, generatedStepsModule, SIMULATED_MODULE_MARKER,
} from '../../src/graph/simulate';
import { resolveGraphRef } from '../../src/graph/resolve';
import { evidenceDirFor } from '../../src/graph/evidence';
import { isDenyStep } from '../../src/journeys/schema';
import { PersonaRegistry } from '../../src/personas/registry';
import type { ProcessGraph } from '../../src/graph/schema';

function cardHtml(graphId: string, index: number, title: string, actor: string): string {
  return `<!doctype html><html><body style="margin:0;font-family:-apple-system,Segoe UI,sans-serif;
      background:#f3f4f6;display:flex;align-items:center;justify-content:center;height:100vh">
    <div style="text-align:center">
      <div style="font-size:13px;letter-spacing:4px;color:#b45309;font-weight:700">SIMULATED EVIDENCE</div>
      <div style="font-size:34px;font-weight:700;color:#111827;margin:12px 0 4px">${title}</div>
      <div style="font-size:16px;color:#4b5563">actor: ${actor}</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:14px">${graphId} · step ${index} · no org was contacted</div>
    </div>
  </body></html>`;
}

test('simulate a green run for a graph', async ({ page }, testInfo) => {
  test.skip(!process.env.SIMULATE, 'set SIMULATE=<graph_id | project/graph_id>');
  const file = resolveGraphRef(String(process.env.SIMULATE)).file;
  const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;
  const id = graph.id;
  const registry = PersonaRegistry.load();
  const walkOpts = { personaIds: registry.ids(), personaAuth: registry.authMethods() };

  // Pass 1 — walk only: the step list drives evidence rendering.
  const walk = simulateReport(graph, walkOpts);

  await page.setViewportSize({ width: 800, height: 450 });
  const shots: (string | undefined)[] = [];
  for (const step of walk.journey.steps) {
    const i = shots.length;
    const title = isDenyStep(step) ? `DENY ${step.deny.capability}` : step.do;
    const actor = isDenyStep(step) ? step.deny.actor : step.actor;
    await page.setContent(cardHtml(graph.id, i, title, actor));
    const shot = testInfo.outputPath(`sim-step-${i}.jpg`);
    await page.screenshot({ path: shot, type: 'jpeg', quality: 60 });
    shots.push(shot);
  }

  // Pass 2 — simulate + merge through the real paint path, then save in place.
  const runId = `sim_${Date.now().toString(36)}`;
  // S4.2 — evidence is written beside the graph (<root>/evidence/…), not
  // inlined into it; the graph keeps the relative ref.
  const result = simulateRun(graph, { ...walkOpts, runId, screenshots: shots, evidenceDir: evidenceDirFor(file) });
  fs.writeFileSync(file, JSON.stringify(result.graph, null, 2) + '\n');

  // Generated-steps module: simulated placeholders, never over real output.
  const moduleFile = path.resolve('src', 'journeys', 'generated', `${id}.steps.ts`);
  const existing = fs.existsSync(moduleFile) ? fs.readFileSync(moduleFile, 'utf8') : undefined;
  if (existing !== undefined && !existing.includes(SIMULATED_MODULE_MARKER) && process.env.SIMULATE_OVERWRITE !== '1') {
    throw new Error(
      `${moduleFile} exists and is NOT simulated — refusing to overwrite real pipeline output (SIMULATE_OVERWRITE=1 to force)`,
    );
  }
  fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
  fs.writeFileSync(moduleFile, generatedStepsModule(graph));

  fs.writeFileSync(testInfo.outputPath('report.json'), JSON.stringify(result.report, null, 2) + '\n');

  console.log(`✔ simulated run '${runId}' merged into ${file}`);
  for (const c of result.changes) console.log(`  · ${c}`);
  for (const w of result.warnings) console.log(`  ⚠ ${w}`);
  console.log(`✔ steps module written: ${moduleFile} (throwing placeholders)`);
  console.log(`next:  npx sfpw suite graph:${id}   ·   npx sfpw grillme ${id}`);
});
