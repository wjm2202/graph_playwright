/**
 * Simulated run (src/graph/simulate.ts) — the no-org path through the real
 * toJourney → mergeRunIntoGraph loop. These tests pin the honesty contract:
 * deterministic output, sim_-stamped evidence, deny steps never counted as
 * captures, and a generated module that throws rather than pretends.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  simulateReport, simulateRun, simulatedRunId, generatedStepsModule,
  SIMULATED_MODULE_MARKER,
} from '../../src/graph/simulate';
import { mergeRunIntoGraph } from '../../src/graph/mergeRun';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';

const GRAPH_FILE = path.resolve('journeys', 'graphs', 'lead_to_customer.graph.json');
const loadGraph = (): ProcessGraph => JSON.parse(fs.readFileSync(GRAPH_FILE, 'utf8')) as ProcessGraph;
const OPTS = { runId: 'test', now: '2026-09-01T00:00:00.000Z' };

test('simulatedRunId always carries the sim_ prefix', () => {
  expect(simulatedRunId('abc')).toBe('sim_abc');
  expect(simulatedRunId('sim_abc')).toBe('sim_abc');
  expect(simulatedRunId()).toBe('sim_local');
});

test('paints every session captured and every oracle pass', () => {
  const result = simulateRun(loadGraph(), OPTS);

  expect(result.report.steps.length).toBeGreaterThan(0);
  expect(result.report.steps.every((s) => s.status === 'ok')).toBe(true);

  const sessions = result.graph.nodes.filter((n) => n.type === 'session');
  expect(sessions.length).toBe(5);
  for (const s of sessions) {
    expect(s.steps?.status, `${s.id} should be captured`).toBe('captured');
    expect(s.steps?.journeyId).toBe('lead_to_customer');
  }

  for (const n of result.graph.nodes) {
    for (const x of n.expects ?? []) {
      expect(x.lastResult?.status, `${n.id}.${x.id} should be painted`).toBe('pass');
      expect(x.lastResult?.runId).toBe('sim_test');
      expect(x.lastResult?.at).toBe(OPTS.now);
    }
  }

  expect(validateGraph(result.graph).ok).toBe(true);
  expect(result.changes.length).toBeGreaterThan(0);
});

test('is deterministic for fixed options', () => {
  const a = simulateRun(loadGraph(), OPTS);
  const b = simulateRun(loadGraph(), OPTS);
  expect(JSON.stringify(a.graph)).toBe(JSON.stringify(b.graph));
  expect(JSON.stringify(a.report)).toBe(JSON.stringify(b.report));
});

test('oracle placement follows the after-filters of the walk', () => {
  const walk = simulateReport(loadGraph(), OPTS);
  const byName = new Map(walk.report.steps.map((s) => [s.name, s]));

  const approve = byName.get('lead.approve_to_customer');
  expect(approve?.oracles?.map((o) => o.id).sort()).toEqual(['conversion_toast', 'customer_created']);

  const check = byName.get('siebel.check_customer');
  expect(check?.oracles?.map((o) => o.id)).toEqual(['customer_visible_in_ui']);

  const assertStep = byName.get('assert.chk_customer');
  expect(assertStep?.oracles?.map((o) => o.id).sort()).toEqual(['customer_in_siebel', 'endpoint_traffic']);

  expect(walk.report.steps.every((s) => (s.oracles ?? []).every((o) => o.message === 'simulated'))).toBe(true);
});

test('deny steps never flip a session to captured', () => {
  const micro: ProcessGraph = {
    schema: 'process-graph/2',
    id: 'deny_micro',
    systems: { sf: { label: 'SF', kind: 'salesforce' } },
    actors: { a: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess', type: 'session', label: 'SF · a', system: 'sf', actor: 'a' },
      { id: 'd', type: 'data', label: 'Record' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess', type: 'login_as' },
      { id: 'e2', from: 'sess', to: 'd', type: 'denied', label: 'must NOT', data: { capability: 'record.approve' } },
    ],
  };
  const result = simulateRun(micro, OPTS);
  expect(result.report.steps[0]?.kind).toBe('deny');
  expect(result.report.steps[0]?.status).toBe('ok');
  const sess = result.graph.nodes.find((n) => n.id === 'sess');
  expect(sess?.steps).toBeUndefined();
});

test('embeds a provided screenshot as the acting session snapshot', ({}, testInfo) => {
  const shot = testInfo.outputPath('shot.jpg');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, Buffer.from('fake-jpeg-bytes-for-embedding-test'));

  const result = simulateRun(loadGraph(), { ...OPTS, screenshots: [shot] });
  const creator = result.graph.nodes.find((n) => n.id === 'sess_sf_lead_creator');
  expect(creator?.snapshot?.status).toBe('captured');
  expect(creator?.snapshot?.ref?.startsWith('data:image/jpeg;base64,')).toBe(true);
});

test('a REAL run retires simulated paint on checks it must skip — real prior results survive', () => {
  const sim = simulateRun(loadGraph(), OPTS);
  const walk = simulateReport(loadGraph(), OPTS);

  // A real run's assert step where both Siebel-side checks were skipped
  // (INVALID_TYPE / no log adapter) — index 5 = e12 (assert.chk_customer).
  const skippedReport = {
    journey: 'lead_to_customer',
    flags: [],
    steps: [{
      index: 5, kind: 'do' as const, actorAlias: 'siebel_admin', personaId: 'siebel_admin',
      name: 'assert.chk_customer', ms: 1200, status: 'ok' as const,
      oracles: [
        { id: 'customer_in_siebel', kind: 'api.record_exists', status: 'skipped' as const, message: 'INVALID_TYPE — lives in Siebel' },
        { id: 'endpoint_traffic', kind: 'log.traffic', status: 'skipped' as const, message: 'no adapter bound' },
      ],
    }],
  };
  const mergeOpts = { journeyId: 'lead_to_customer', stepEdgeIds: walk.stepEdgeIds, runId: 'real_1' };

  const real = mergeRunIntoGraph(sim.graph, skippedReport, mergeOpts);
  const chk = real.graph.nodes.find((n) => n.id === 'chk_customer');
  expect(chk?.expects?.find((x) => x.id === 'customer_in_siebel')?.lastResult).toBeUndefined();
  expect(chk?.expects?.find((x) => x.id === 'endpoint_traffic')?.lastResult).toBeUndefined();
  expect(real.changes.join()).toContain('simulated paint cleared');

  // A REAL prior result is evidence — a later skip must not erase it.
  const painted = simulateRun(loadGraph(), OPTS).graph;
  const prior = painted.nodes.find((n) => n.id === 'chk_customer')!.expects!.find((x) => x.id === 'customer_in_siebel')!;
  prior.lastResult = { status: 'pass', at: '2026-08-01T00:00:00.000Z', runId: 'real_0' };
  const kept = mergeRunIntoGraph(painted, skippedReport, mergeOpts);
  expect(kept.graph.nodes.find((n) => n.id === 'chk_customer')!.expects!.find((x) => x.id === 'customer_in_siebel')!.lastResult)
    .toMatchObject({ status: 'pass', runId: 'real_0' });

  // And a SIMULATED run's own skip never clears anything.
  const simAgain = mergeRunIntoGraph(sim.graph, skippedReport, { ...mergeOpts, runId: 'sim_again' });
  expect(simAgain.graph.nodes.find((n) => n.id === 'chk_customer')!.expects!.find((x) => x.id === 'customer_in_siebel')!.lastResult)
    .toMatchObject({ status: 'pass', runId: 'sim_test' });
});

test('generatedStepsModule lists the vocabulary and is marked simulated', () => {
  const src = generatedStepsModule(loadGraph());
  expect(src).toContain(SIMULATED_MODULE_MARKER);
  expect(src).toContain('export function registerSteps_lead_to_customer(');
  for (const name of [
    'lead.create', 'lead.progress_to_potential', 'credit.check',
    'lead.approve_to_customer', 'siebel.check_customer',
  ]) {
    const hits = src.split(`.register('${name}'`).length - 1;
    expect(hits, `${name} registered exactly once`).toBe(1);
  }
  expect(src).not.toContain('plan.');
  // No denied edges in this graph — the deny-probe helper must not be emitted.
  expect(src).not.toContain('registerDeny');
});
