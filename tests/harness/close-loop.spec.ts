/**
 * THE FULL AUTOMATED LOOP, live in a real browser and no org:
 * plan graph → toJourney → run (real Cast contexts, central oracle
 * evaluation, per-step screenshots) → merge-back paints the plan.
 * Proven BOTH ways: a passing run paints green with embedded snapshots;
 * a failing oracle throws JourneyRunError and paints red — automatically.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import { StepCatalog } from '../../src/journeys/catalog';
import { runGraph, runGraphFile } from '../../src/graph/run';
import type { ProcessGraph } from '../../src/graph/schema';

const personasDoc = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  personas: { demo_user: { kind: 'internal', usernameEnv: 'SF_DEMO_USERNAME' } },
};

const planGraph = (): ProcessGraph => ({
  schema: 'process-graph/2',
  id: 'close_loop_demo',
  systems: { app: { label: 'Demo app', kind: 'web' } },
  actors: { operator: 'demo_user' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess', type: 'session', label: 'Demo · operator', system: 'app', actor: 'operator' },
    {
      id: 'record', type: 'data', label: 'Demo record',
      expects: [{ id: 'saved_visible', kind: 'ui.text', value: 'record saved', note: 'save confirmation on screen' }],
    },
    {
      id: 'chk_done', type: 'checkpoint', label: 'Flow complete',
      expects: [{ id: 'done_heading', kind: 'ui.visible', target: 'All done', note: 'terminal state reached' }],
    },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'sess', type: 'login_as' },
    { id: 'e2', from: 'sess', to: 'record', type: 'does', data: { catalog: 'demo.save' } },
    { id: 'e3', from: 'sess', to: 'chk_done', type: 'asserts' },
    { id: 'e4', from: 'sess', to: 'end', type: 'next' },
  ],
});

test('green path: run paints oracles pass, captures status + snapshots — untouched by hand', async ({ browser }) => {
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(personasDoc),
    authenticator: async (_id, b) => b.newContext(),
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runloop-'));
  const catalog = new StepCatalog().register('demo.save', async ({ page }) => {
    await page.setContent('<main><p>record saved</p><h1>All done</h1></main>');
  });

  try {
    const result = await runGraph(planGraph(), {
      cast, catalog, personaIds: ['demo_user'], runDir,
    });

    expect(result.error).toBeUndefined();
    // Report: the does step AND the catalog-less assert.* step both ran, with oracles.
    expect(result.report.steps.map((s) => `${s.name}:${s.status}`)).toEqual([
      'demo.save:ok',
      'assert.chk_done:ok',
    ]);
    expect(result.report.steps[0]!.oracles).toEqual([{ id: 'saved_visible', kind: 'ui.text', status: 'pass' }]);
    expect(result.report.steps[1]!.oracles).toEqual([{ id: 'done_heading', kind: 'ui.visible', status: 'pass' }]);

    // Screenshots exist on disk and are wired into the report.
    for (const s of result.report.steps) {
      expect(s.screenshot && fs.existsSync(s.screenshot)).toBe(true);
    }
    expect(fs.existsSync(path.join(runDir, 'report.json'))).toBe(true);

    // The plan graph came back PAINTED:
    const record = result.graph.nodes.find((n) => n.id === 'record')!;
    expect(record.expects![0]!.lastResult?.status).toBe('pass');
    const chk = result.graph.nodes.find((n) => n.id === 'chk_done')!;
    expect(chk.expects![0]!.lastResult?.status).toBe('pass');
    expect(chk.snapshot?.ref).toMatch(/^data:image\/jpeg;base64,/); // checkpoint holds the assert-step shot
    const sess = result.graph.nodes.find((n) => n.id === 'sess')!;
    expect(sess.steps).toMatchObject({ status: 'captured', journeyId: 'close_loop_demo' });
    expect(sess.snapshot?.ref).toMatch(/^data:image\/jpeg;base64,/);
  } finally {
    await cast.releaseAll();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});

test('file flavor: runGraphFile saves the painted graph in place and logs labour telemetry', async ({ browser }) => {
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(personasDoc),
    authenticator: async (_id, b) => b.newContext(),
  });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'runfile-'));
  const graphFile = path.join(tmp, 'close_loop_demo.graph.json');
  fs.writeFileSync(graphFile, JSON.stringify(planGraph(), null, 2));
  const telemetry = path.join(tmp, 'telemetry.jsonl');
  const prevTel = process.env.TELEMETRY_FILE;
  process.env.TELEMETRY_FILE = telemetry;
  const catalog = new StepCatalog().register('demo.save', async ({ page }) => {
    await page.setContent('<main><p>record saved</p><h1>All done</h1></main>');
  });

  try {
    const result = await runGraphFile(graphFile, {
      cast, catalog, personaIds: ['demo_user'], runDir: path.join(tmp, 'run'),
    });
    expect(result.error).toBeUndefined();

    // The graph FILE now carries the paint:
    const saved = JSON.parse(fs.readFileSync(graphFile, 'utf8')) as ProcessGraph;
    expect(saved.nodes.find((n) => n.id === 'record')!.expects![0]!.lastResult?.status).toBe('pass');

    // And the labour ledger gained a green run event:
    const events = fs.readFileSync(telemetry, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(events).toEqual([
      expect.objectContaining({ kind: 'run', id: 'close_loop_demo', ok: true }),
    ]);
  } finally {
    if (prevTel === undefined) delete process.env.TELEMETRY_FILE; else process.env.TELEMETRY_FILE = prevTel;
    await cast.releaseAll();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('red path: a failing oracle throws with evidence and paints the plan red', async ({ browser }) => {
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(personasDoc),
    authenticator: async (_id, b) => b.newContext(),
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runloop-'));
  const catalog = new StepCatalog().register('demo.save', async ({ page }) => {
    await page.setContent('<main><p>save FAILED silently</p></main>'); // no 'record saved'
  });

  try {
    const result = await runGraph(planGraph(), { cast, catalog, personaIds: ['demo_user'], runDir });

    expect(result.error).toBeDefined();
    expect(result.error!.message).toContain("oracle failed on 'demo.save'");
    expect(result.error!.message).toContain('saved_visible');

    const failed = result.report.steps[0];
    expect(failed!.status).toBe('failed');
    expect(failed!.oracles).toEqual([
      expect.objectContaining({ id: 'saved_visible', status: 'fail' }),
    ]);
    expect(failed!.screenshot && fs.existsSync(failed!.screenshot)).toBe(true); // failure evidence

    const record = result.graph.nodes.find((n) => n.id === 'record')!;
    expect(record.expects![0]!.lastResult?.status).toBe('fail');
  } finally {
    await cast.releaseAll();
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
