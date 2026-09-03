/**
 * Close-the-loop pure parts: merge-back painting, the baselines the file
 * runner feeds the grader, walker edge-id mapping, and the JourneyRunError
 * contract. (Which graphs a run covers is `tests/unit/suites.spec.ts`; the
 * spec that runs them is `tests/e2e/graphs.spec.ts`.)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Page } from '@playwright/test';
import { mergeRunIntoGraph } from '../../src/graph/mergeRun';
import { toJourney } from '../../src/graph/toJourney';
import { runGraphFile } from '../../src/graph/run';
import { JourneyRunError, runJourney, baselineKey, type JourneyReport, type CastLike } from '../../src/journeys/runner';
import { StepCatalog } from '../../src/journeys/catalog';
import { emptyBaselines, saveBaselinesFile, loadBaselinesFile, type StoredBaselines } from '../../src/journeys/baselines';
import { goodGraphV2 } from '../helpers/sampleGraph';

const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest', 'siebel_admin'];

test.describe('mergeRunIntoGraph', () => {
  test('paints oracle results, captured status, timing, and embeds snapshots', () => {
    const g = goodGraphV2();
    const walked = toJourney(g, { personaIds: PERSONAS });
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
    const shot = path.join(shotDir, 's0.jpg');
    fs.writeFileSync(shot, Buffer.from('fakejpegbytes'));

    const report: JourneyReport = {
      journey: 'expense_to_siebel',
      flags: [],
      steps: [
        {
          index: 0, kind: 'do', actorAlias: 'submitter', personaId: 'sales_user',
          name: 'expense.submit', ms: 840, status: 'ok',
          oracles: [{ id: 'expense_saved', kind: 'api.record_exists', status: 'pass' }],
          screenshot: shot,
        },
        { index: 1, kind: 'deny', actorAlias: 'submitter', personaId: 'sales_user', name: 'expense.approve', ms: 20, status: 'ok' },
        {
          index: 2, kind: 'do', actorAlias: 'approver', personaId: 'admin',
          name: 'expense.approve', ms: 1300, status: 'ok',
          oracles: [{ id: 'expense_approved', kind: 'api.field_equals', status: 'fail', message: 'Status__c was Draft' }],
        },
      ],
    };

    const { graph, changes } = mergeRunIntoGraph(g, report, {
      journeyId: 'expense_to_siebel', stepEdgeIds: walked.stepEdgeIds, runId: 'run1', now: '2026-08-31T10:00:00Z',
    });

    const expense = graph.nodes.find((n) => n.id === 'expense')!;
    expect(expense.expects![0]!.lastResult).toEqual({ status: 'pass', at: '2026-08-31T10:00:00Z', runId: 'run1' });
    expect(expense.expects![1]!.lastResult).toMatchObject({ status: 'fail', message: 'Status__c was Draft' });

    const sales = graph.nodes.find((n) => n.id === 'sess_sf_sales')!;
    expect(sales.steps).toMatchObject({ status: 'captured', journeyId: 'expense_to_siebel' });
    expect(sales.timing?.capturedMeanMs).toBe(840);
    expect(sales.snapshot?.ref).toMatch(/^data:image\/jpeg;base64,/);

    expect(changes.join()).toContain('expense.expense_saved: pass');
    expect(changes.join()).toContain('expense.expense_approved: fail');
    // The source graph is untouched (pure merge):
    expect(g.nodes.find((n) => n.id === 'expense')!.expects![0]!.lastResult).toBeUndefined();
    fs.rmSync(shotDir, { recursive: true, force: true });
  });

  test('a failed step paints its emitted oracles red even without per-oracle detail', () => {
    const g = goodGraphV2();
    const walked = toJourney(g, { personaIds: PERSONAS });
    const report: JourneyReport = {
      journey: 'expense_to_siebel', flags: [],
      steps: [{
        index: 0, kind: 'do', actorAlias: 'submitter', personaId: 'sales_user',
        name: 'expense.submit', ms: 100, status: 'failed', note: 'page exploded',
      }],
    };
    const { graph } = mergeRunIntoGraph(g, report, {
      journeyId: 'expense_to_siebel', stepEdgeIds: walked.stepEdgeIds, now: 'now',
    });
    const expense = graph.nodes.find((n) => n.id === 'expense')!;
    expect(expense.expects![0]!.lastResult).toMatchObject({ status: 'fail', message: 'page exploded' });
    // The approve-phase oracle was NOT emitted for this edge — untouched:
    expect(expense.expects![1]!.lastResult).toBeUndefined();
  });

  test('oversized snapshots are skipped with a note; stale edge ids are skipped safely', () => {
    const g = goodGraphV2();
    const walked = toJourney(g, { personaIds: PERSONAS });
    const shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
    const big = path.join(shotDir, 'big.jpg');
    fs.writeFileSync(big, Buffer.alloc(500_000));
    const report: JourneyReport = {
      journey: 'expense_to_siebel', flags: [],
      steps: [
        { index: 0, kind: 'do', actorAlias: 'submitter', personaId: 'sales_user', name: 'expense.submit', ms: 1, status: 'ok', screenshot: big },
      ],
    };
    const { graph, changes } = mergeRunIntoGraph(g, report, {
      journeyId: 'x', stepEdgeIds: ['ghost_edge'], now: 'now',
    });
    expect(changes.join()).toContain("edge 'ghost_edge' no longer in graph");
    expect(graph.nodes.find((n) => n.id === 'sess_sf_sales')!.snapshot).toBeUndefined();

    const ok = mergeRunIntoGraph(g, report, { journeyId: 'x', stepEdgeIds: walked.stepEdgeIds, now: 'now', maxSnapshotBytes: 1000 });
    expect(ok.changes.join()).toContain('snapshot skipped');
    fs.rmSync(shotDir, { recursive: true, force: true });
  });
});

test.describe('JourneyRunError', () => {
  test('a failing run throws WITH its partial report (evidence survives)', async () => {
    const journey = {
      journey: 'boom', actors: { a: 'admin' },
      steps: [
        { actor: 'a', do: 'ok.step' },
        { actor: 'a', do: 'bad.step' },
      ],
    };
    const catalog = new StepCatalog()
      .register('ok.step', async () => {})
      .register('bad.step', async () => { throw new Error('kaput'); });
    const cast = {
      as: async () => ({ isClosed: () => false } as never),
      deny: async () => {},
    };
    try {
      await runJourney(journey, { cast, catalog });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(JourneyRunError);
      const err = e as JourneyRunError;
      expect(err.message).toContain('kaput');
      expect(err.report.steps.map((s) => s.status)).toEqual(['ok', 'failed']);
      expect(err.report.steps[1]!.note).toContain('kaput');
    }
  });
});

test.describe('runGraphFile ↔ baselines', () => {
  // The timing grade (soft ×1.5 / hard ×3) was dead code until the file
  // runner fed it: baselines live in journeys/baselines/<id>.baselines.json,
  // are READ when present and folded back in after a fully green run.
  const runDeps = (msPerCall: number) => {
    let t = 0;
    const cast: CastLike = {
      as: async () => ({ url: () => 'about:blank' }) as unknown as Page,
      deny: async () => {},
    };
    const catalog = new StepCatalog()
      .register('expense.submit', async ({ produce }) => { produce('expense', { id: 'a03000000000001AAA', sobject: 'Expense__c' }); })
      .register('expense.approve', async () => {})
      .register('siebel.verify_expense', async () => {})
      .registerDeny('expense.approve', () => ({ ui: async () => { /* control absent → refusal proven */ } }));
    return { cast, catalog, personaIds: PERSONAS, clock: () => (t += msPerCall) };
  };

  /** A scratch repo corner: the graph to run + the baselines folder. */
  function scratch(): { dir: string; graphFile: string; baselinesDir: string; baselinesFile: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runfile-'));
    const graphFile = path.join(dir, 'expense_to_siebel.graph.json');
    fs.writeFileSync(graphFile, JSON.stringify(goodGraphV2(), null, 2));
    const baselinesDir = path.join(dir, 'baselines');
    process.env.TELEMETRY_FILE = path.join(dir, 'telemetry.jsonl');
    return { dir, graphFile, baselinesDir, baselinesFile: path.join(baselinesDir, 'expense_to_siebel.baselines.json') };
  }

  test.afterEach(() => { delete process.env.TELEMETRY_FILE; });

  test('no baselines file → no grading, and none is invented', async () => {
    const s = scratch();
    const r = await runGraphFile(s.graphFile, runDeps(10_000), { baselinesDir: s.baselinesDir });
    expect(r.error).toBeUndefined();
    expect(r.report.steps.every((x) => x.status === 'ok')).toBe(true);
    // Baselines start with the capture pipeline; a run never creates one.
    expect(fs.existsSync(s.baselinesFile)).toBe(false);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  test('an existing baselines file grades the run — a blown hard budget fails it', async () => {
    const s = scratch();
    const doc: StoredBaselines = emptyBaselines('expense_to_siebel');
    doc.steps[baselineKey(0, 'submitter', 'expense.submit')] = { n: 3, meanMs: 100, p95Ms: 100, samples: [100, 100, 100] };
    saveBaselinesFile(s.baselinesFile, doc);

    const r = await runGraphFile(s.graphFile, runDeps(5_000), { baselinesDir: s.baselinesDir });
    expect(r.error).toBeInstanceOf(JourneyRunError);
    expect(r.error!.message).toMatch(/blew the timing budget: 5000ms vs baseline p95 100ms × 3/);
    // A red run never moves the bar it just failed against.
    expect(loadBaselinesFile(s.baselinesFile, 'expense_to_siebel').steps[baselineKey(0, 'submitter', 'expense.submit')]!.n).toBe(3);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });

  test('a green run folds its durations back into the window', async () => {
    const s = scratch();
    const key = baselineKey(0, 'submitter', 'expense.submit');
    const doc: StoredBaselines = emptyBaselines('expense_to_siebel');
    doc.steps[key] = { n: 1, meanMs: 400, p95Ms: 400, samples: [400] };
    saveBaselinesFile(s.baselinesFile, doc);

    const r = await runGraphFile(s.graphFile, runDeps(500), { baselinesDir: s.baselinesDir });
    expect(r.error).toBeUndefined();
    const after = loadBaselinesFile(s.baselinesFile, 'expense_to_siebel');
    expect(after.steps[key]).toMatchObject({ n: 2, samples: [400, 500], p95Ms: 500 });
    // Every graded step of the walk is in the window now, not just the seeded one.
    expect(Object.keys(after.steps).length).toBe(r.report.steps.filter((x) => x.kind === 'do').length);
    fs.rmSync(s.dir, { recursive: true, force: true });
  });
});
