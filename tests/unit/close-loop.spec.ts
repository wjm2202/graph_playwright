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
import { evidenceDirFor, isDataUrlRef, resolveEvidenceRef } from '../../src/graph/evidence';
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
    // No evidenceDir was given (an in-memory graph has no folder to write
    // into), so the legacy inline form is what a caller gets:
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

// ---------------------------------------------------------------------------
// S4.2 — evidence lives in FILES. Merge-back writes each screenshot under the
// graph's own evidence folder and keeps a short relative ref, so a repainted
// graph is a readable diff (review §3.2: lead_to_customer was 91 KB, 79 KB of
// it base64 JPEGs).
// ---------------------------------------------------------------------------
test.describe('mergeRunIntoGraph → evidence files', () => {
  const shotReport = (shot: string): JourneyReport => ({
    journey: 'expense_to_siebel', flags: [],
    steps: [{
      index: 0, kind: 'do', actorAlias: 'submitter', personaId: 'sales_user',
      name: 'expense.submit', ms: 12, status: 'ok', screenshot: shot,
    }],
  });

  /** A scratch repo corner shaped like the real thing: <root>/graphs + the
   *  evidence folder the ref is relative to. */
  function scratch(): { root: string; graphFile: string; evidenceDir: string; shot: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evid-'));
    fs.mkdirSync(path.join(root, 'graphs'), { recursive: true });
    const graphFile = path.join(root, 'graphs', 'expense_to_siebel.graph.json');
    fs.writeFileSync(graphFile, JSON.stringify(goodGraphV2(), null, 2));
    const shot = path.join(root, 'shot.jpg');
    fs.writeFileSync(shot, Buffer.from('fakejpegbytes'));
    return { root, graphFile, evidenceDir: evidenceDirFor(graphFile), shot };
  }

  test('the graph root is the graphs folder\'s parent — evidence sits beside it', () => {
    expect(evidenceDirFor('/repo/projects/crm/graphs/x.graph.json')).toBe(path.resolve('/repo/projects/crm/evidence'));
    expect(evidenceDirFor('/repo/journeys/graphs/x.graph.json')).toBe(path.resolve('/repo/journeys/evidence'));
    // A graph loose in a folder of its own keeps evidence beside it.
    expect(evidenceDirFor('/tmp/scratch/x.graph.json')).toBe(path.resolve('/tmp/scratch/evidence'));
  });

  test('a screenshot becomes a file, and the node keeps the relative ref', () => {
    const s = scratch();
    const g = goodGraphV2();
    const walked = toJourney(g, { personaIds: PERSONAS });
    const { graph, changes } = mergeRunIntoGraph(g, shotReport(s.shot), {
      journeyId: 'expense_to_siebel', stepEdgeIds: walked.stepEdgeIds,
      runId: 'run_a', evidenceDir: s.evidenceDir, now: '2026-09-03T09:00:00Z',
    });

    const snap = graph.nodes.find((n) => n.id === 'sess_sf_sales')!.snapshot!;
    expect(snap).toEqual({
      status: 'captured',
      ref: 'evidence/expense_to_siebel/run_a/sess_sf_sales.jpg',
      capturedAt: '2026-09-03T09:00:00Z',
    });
    // The ref resolves, from the graph file, to the file that was written.
    const onDisk = resolveEvidenceRef(s.graphFile, snap.ref)!;
    expect(fs.readFileSync(onDisk, 'utf8')).toBe('fakejpegbytes');
    expect(onDisk).toBe(path.join(s.evidenceDir, 'expense_to_siebel', 'run_a', 'sess_sf_sales.jpg'));
    // No base64 anywhere in the document — that is the whole point.
    expect(JSON.stringify(graph)).not.toContain('base64');
    expect(changes.join()).toContain('evidence/expense_to_siebel/run_a/sess_sf_sales.jpg');
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  test('a second run writes a second runId folder — the first is still there', () => {
    const s = scratch();
    const g = goodGraphV2();
    const walked = toJourney(g, { personaIds: PERSONAS });
    const opts = { journeyId: 'expense_to_siebel', stepEdgeIds: walked.stepEdgeIds, evidenceDir: s.evidenceDir };
    const first = mergeRunIntoGraph(g, shotReport(s.shot), { ...opts, runId: 'run_a' });
    const second = mergeRunIntoGraph(first.graph, shotReport(s.shot), { ...opts, runId: 'run_b' });

    expect(second.graph.nodes.find((n) => n.id === 'sess_sf_sales')!.snapshot!.ref)
      .toBe('evidence/expense_to_siebel/run_b/sess_sf_sales.jpg');
    expect(fs.readdirSync(path.join(s.evidenceDir, 'expense_to_siebel')).sort()).toEqual(['run_a', 'run_b']);
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  test('an old inline ref survives untouched until that node is re-merged', () => {
    const s = scratch();
    const g = goodGraphV2();
    // An old graph: both a session and a checkpoint painted as data URLs.
    const inline = 'data:image/jpeg;base64,AAAA';
    for (const id of ['sess_sf_sales', 'sess_siebel_admin']) {
      g.nodes.find((n) => n.id === id)!.snapshot = { status: 'captured', ref: inline, capturedAt: 'then' };
    }
    const walked = toJourney(g, { personaIds: PERSONAS });
    const { graph } = mergeRunIntoGraph(g, shotReport(s.shot), {
      journeyId: 'expense_to_siebel', stepEdgeIds: walked.stepEdgeIds, runId: 'run_a', evidenceDir: s.evidenceDir,
    });

    // The node this run touched migrated; the one it did not still opens.
    expect(graph.nodes.find((n) => n.id === 'sess_sf_sales')!.snapshot!.ref).toBe('evidence/expense_to_siebel/run_a/sess_sf_sales.jpg');
    const untouched = graph.nodes.find((n) => n.id === 'sess_siebel_admin')!.snapshot!;
    expect(untouched).toEqual({ status: 'captured', ref: inline, capturedAt: 'then' });
    expect(isDataUrlRef(untouched.ref)).toBe(true);
    // A data URL is never mistaken for a path (it must not resolve to a file).
    expect(resolveEvidenceRef(s.graphFile, untouched.ref)).toBeUndefined();
    fs.rmSync(s.root, { recursive: true, force: true });
  });

  test('a ref pointing outside the evidence folder resolves to nothing', () => {
    const s = scratch();
    for (const ref of ['../../.env', 'evidence/../../secrets.txt', '/etc/passwd', '']) {
      expect(resolveEvidenceRef(s.graphFile, ref), ref).toBeUndefined();
    }
    fs.rmSync(s.root, { recursive: true, force: true });
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
