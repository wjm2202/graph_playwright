/**
 * Close-the-loop pure parts: merge-back painting, spec emission, walker
 * edge-id mapping, and the JourneyRunError contract.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mergeRunIntoGraph } from '../../src/graph/mergeRun';
import { toSpec } from '../../src/graph/toSpec';
import { toJourney } from '../../src/graph/toJourney';
import { JourneyRunError, runJourney, type JourneyReport } from '../../src/journeys/runner';
import { StepCatalog } from '../../src/journeys/catalog';
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

test.describe('toSpec', () => {
  test('emits a runnable, self-updating spec bound to the graph file', () => {
    const src = toSpec(goodGraphV2());
    expect(src).toContain("journeys/graphs/expense_to_siebel.graph.json");
    expect(src).toContain("require('../../src/journeys/generated/expense_to_siebel.steps')");
    expect(src).toContain('registerSteps_expense_to_siebel');
    expect(src).toContain('runGraphFile(GRAPH');
    // One test() per persona-matrix binding; the default keeps the plain title.
    expect(src).toContain("test(variant.id === 'default' ? 'Expense flows into Siebel' : 'Expense flows into Siebel · as ' + variant.label");
    expect(src).toContain('GRAPH_SPEC=expense_to_siebel npm run graph:spec');
    expect(src).not.toContain('networkidle');
  });

  test('wires the SalesforceApi oracle so backend checks assert persistence', () => {
    const src = toSpec(goodGraphV2());
    // Bound only when a REST token exists; otherwise checks skip, never pass.
    expect(src).toContain('const env = loadEnv();');
    expect(src).toContain('env?.accessToken');
    expect(src).toContain('salesforceApiOracle(new SalesforceApi(request, env.instanceUrl, env.accessToken, env.apiVersion), {');
    // Default scope = THIS run's records; ORACLE_SCOPE=suite widens it.
    expect(src).toContain("scope: process.env.ORACLE_SCOPE === 'suite' ? 'suite' : 'run'");
    expect(src).toContain('...(apiOracle ? { apiOracle } : {})');
    expect(src).toContain("async ({ cast, request }, testInfo)");
  });

  test('refuses invalid graphs', () => {
    const bad = goodGraphV2();
    bad.edges.push({ id: 'x', from: 'start', to: 'ghost', type: 'next' });
    expect(() => toSpec(bad)).toThrow(/cannot emit a spec for an invalid graph/);
  });
});
