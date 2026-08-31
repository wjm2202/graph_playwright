/**
 * PG-1 — capture→graph: per-step lanes + timing edges, system attribution via
 * URL origins, cross-actor handoffs, aggregate DFG math, mermaid export, and
 * the committed-fixture integration (trace → distill → graph → valid).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { fromDistillation } from '../../src/graph/fromDistillation';
import { toMermaid, fmtMs } from '../../src/graph/mermaid';
import { validateGraph } from '../../src/graph/schema';
import { readTrace } from '../../src/pipeline/traceReader';
import { distill, type Distillation } from '../../src/pipeline/distill';

const stepAt = (
  catalog: string,
  startMs: number,
  endMs: number,
  args: Record<string, unknown> = {},
  actorAlias?: string,
): Distillation['steps'][0] => ({
  kind: 'step', catalog, args, startMs, endMs, durationMs: endMs - startMs,
  recognized: true, sourceEvents: [], ...(actorAlias ? { actorAlias } : {}),
});

const SYSTEMS = {
  sf: { label: 'Salesforce', kind: 'salesforce' as const },
  siebel: { label: 'Siebel', kind: 'siebel' as const, sessionPolicy: { maxConcurrent: 1 } },
};

test('per-step mode: nodes in actor lanes, next edges carry the human gap', () => {
  const d: Distillation = {
    steps: [
      stepAt('form.fill', 100, 150, { label: 'Amount', value: '4999' }),
      stepAt('modal.save', 400, 900, { button: 'Save' }),
    ],
    harvestedIds: [],
    flags: [],
  };
  const g = fromDistillation(d, { graphId: 'demo', actors: { main: 'sales_user' } });
  expect(validateGraph(g).errors).toEqual([]);
  expect(g.nodes.map((n) => `${n.id}:${n.label}@${n.actor}`)).toEqual([
    'n0:form.fill: Amount@main',
    'n1:modal.save: Save@main',
  ]);
  expect(g.edges).toEqual([
    { id: 'e1', from: 'n0', to: 'n1', type: 'next', data: { deltaMs: 250 } },
  ]);
  expect(g.nodes[0]!.steps).toEqual({ status: 'captured', stepIndexes: [0] });
  expect(g.nodes[1]!.timing).toEqual({ capturedMeanMs: 500 });
});

test('system attribution: URL origins flip the lane; it sticks for later steps', () => {
  const d: Distillation = {
    steps: [
      stepAt('nav.goto', 0, 10, { url: 'https://uat.my.salesforce.com/lightning/page/home' }),
      stepAt('ui.click', 20, 30, { role: 'button', name: 'Go' }),
      stepAt('nav.goto', 40, 50, { url: 'https://siebel.corp/app' }),
      stepAt('ui.click', 60, 70, { role: 'button', name: 'Verify' }),
    ],
    harvestedIds: [],
    flags: [],
  };
  const g = fromDistillation(d, {
    graphId: 'x', actors: { main: 'admin' }, systems: SYSTEMS,
    systemByOrigin: { 'https://uat.my.salesforce.com': 'sf', 'https://siebel.corp': 'siebel' },
  });
  expect(g.nodes.map((n) => n.system)).toEqual(['sf', 'sf', 'siebel', 'siebel']);
  expect(g.edges.map((e) => e.type)).toEqual(['next', 'navigates', 'next']);
});

test('handoff edges appear where a record id crosses actors', () => {
  const d: Distillation = {
    steps: [
      stepAt('expense.submit', 0, 100, { expense: 'a03xx0000012AbCDEF' }, 'submitter'),
      stepAt('expense.approve', 500, 700, { expense: 'a03xx0000012AbCDEF' }, 'approver'),
    ],
    harvestedIds: [{ id: 'a03xx0000012AbCDEF', firstEvent: 0 }],
    flags: [],
  };
  const g = fromDistillation(d, { graphId: 'x', actors: { submitter: 'sales_user', approver: 'admin' } });
  const handoff = g.edges.find((e) => e.type === 'handoff');
  expect(handoff).toMatchObject({ from: 'n0', to: 'n1', data: { recordRef: 'a03xx0000012AbCDEF' } });
});

test('aggregate DFG: frequencies, mean gaps, per-(actor,activity) timing, start/end', () => {
  const d: Distillation = {
    steps: [
      stepAt('ui.click', 0, 100, {}, 'a'),     // 100ms
      stepAt('form.fill', 200, 300, {}, 'a'),  // gap 100
      stepAt('ui.click', 400, 700, {}, 'a'),   // gap 100, 300ms
    ],
    harvestedIds: [],
    flags: [],
  };
  const g = fromDistillation(d, { graphId: 'x', actors: { a: 'admin' }, aggregate: true });
  expect(validateGraph(g).errors).toEqual([]);

  const click = g.nodes.find((n) => n.id === 'a_a_ui_click')!;
  expect(click.steps?.stepIndexes).toEqual([0, 2]);
  expect(click.timing).toEqual({ capturedMeanMs: 200, capturedP95Ms: 300 });

  const clickToFill = g.edges.find((e) => e.from === 'a_a_ui_click' && e.to === 'a_a_form_fill')!;
  const fillToClick = g.edges.find((e) => e.from === 'a_a_form_fill' && e.to === 'a_a_ui_click')!;
  expect(clickToFill.data).toEqual({ frequency: 1, meanMs: 100 });
  expect(fillToClick.data).toEqual({ frequency: 1, meanMs: 100 });
  expect(g.edges.find((e) => e.from === 'start')!.to).toBe('a_a_ui_click');
  expect(g.edges.find((e) => e.to === 'end')!.from).toBe('a_a_ui_click');
});

test('mermaid export: subgraphs per system, arrows per edge type, timing labels', () => {
  const d: Distillation = {
    steps: [
      stepAt('nav.goto', 0, 10, { url: 'https://uat.my.salesforce.com/x' }),
      stepAt('modal.save', 100, 1600, { button: 'Save' }),
    ],
    harvestedIds: [],
    flags: [],
  };
  const g = fromDistillation(d, {
    graphId: 'x', actors: { main: 'admin' }, systems: SYSTEMS,
    systemByOrigin: { 'https://uat.my.salesforce.com': 'sf' },
  });
  g.edges.push({ id: 'd1', from: 'n0', to: 'n1', type: 'deny', data: { capability: 'expense.approve' } });

  const mm = toMermaid(g);
  expect(mm).toContain('flowchart LR');
  expect(mm).toContain('subgraph sf[Salesforce]');
  expect(mm).toContain('n0 -->|90ms| n1');
  expect(mm).toContain('n0 -.->|deny expense.approve| n1');
  expect(mm).toContain('1.5s');
  expect(fmtMs(999)).toBe('999ms');
  expect(fmtMs(2100)).toBe('2.1s');
});

test('fixture integration: trace → distill → graph validates with the right shape', () => {
  const d = distill(readTrace(path.resolve(__dirname, '../fixtures/trace-demo/trace.zip')).events);
  const g = fromDistillation(d, {
    graphId: 'fixture_demo_graph',
    actors: { main: 'sales_user' },
    systems: SYSTEMS,
    systemByOrigin: { 'https://fixture.test': 'sf' },
    journeyId: 'fixture_demo',
  });
  expect(validateGraph(g).errors).toEqual([]);
  expect(g.nodes).toHaveLength(4);
  expect(g.nodes.map((n) => n.system)).toEqual(['sf', 'sf', 'sf', 'sf']);
  expect(g.nodes[0]!.label).toBe('open Account');
  expect(g.nodes.every((n) => n.steps?.journeyId === 'fixture_demo')).toBe(true);
  expect(toMermaid(g)).toContain('modal.save');
});
