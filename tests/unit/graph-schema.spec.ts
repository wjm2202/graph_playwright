/**
 * PG-0 — process-graph validation: every rule, every error surfaced at once.
 */
import { test, expect } from '@playwright/test';
import { validateGraph } from '../../src/graph/schema';
import { goodGraphV2 } from '../helpers/sampleGraph';

const node = (g: ReturnType<typeof goodGraphV2>, id: string) => g.nodes.find((n) => n.id === id)!;

test('a well-formed graph passes with zero errors', () => {
  expect(validateGraph(goodGraphV2()).errors).toEqual([]);
});

// (Seed-file drift guarding lives in graph-v2.spec — the shipped seed IS the
//  sample. v1 documents never reach this validator: upgrade.ts converts them
//  at the load door, and graph-v2.spec covers that door.)

test('schema tag, id grammar, and object shape are enforced', () => {
  expect(validateGraph(null).errors).toEqual(['graph must be an object']);
  const g = goodGraphV2() as unknown as Record<string, unknown>;
  g.schema = 'process-graph/1';
  g.id = 'Bad Id';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain("schema: must be 'process-graph/2'");
  expect(r.errors.join()).toContain('id: lower_snake_case');
});

test('system rules: label, kind, urlEnv name-shape, sessionPolicy bounds', () => {
  const g = goodGraphV2();
  g.systems.sf!.urlEnv = 'https://uat.my.salesforce.com';
  (g.systems.siebel!.sessionPolicy as { maxConcurrent: number }).maxConcurrent = 0;
  (g.systems as Record<string, unknown>).BadKey = { label: 'x', kind: 'weird' };
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('systems.sf.urlEnv: must be an ENV VAR NAME');
  expect(r.errors.join()).toContain('sessionPolicy.maxConcurrent: integer >= 1');
  expect(r.errors.join()).toContain('systems.BadKey: key must be lower_snake_case');
  expect(r.errors.join()).toContain('systems.BadKey.kind');
});

test('nodes: unknown lanes, credentialed URLs, inline account values are rejected', () => {
  const g = goodGraphV2();
  node(g, 'sess_sf_sales').system = 'sap';
  node(g, 'sess_sf_sales').actor = 'ghost';
  node(g, 'sess_sf_sales').account = { usernameEnv: 'hunter2!' };
  node(g, 'sess_sf_admin').url = 'https://admin:secret@siebel.corp/app';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain("nodes.sess_sf_sales.system: 'sap' not in systems");
  expect(r.errors.join()).toContain("nodes.sess_sf_sales.actor: 'ghost' not in actors");
  expect(r.errors.join()).toContain('usernameEnv: must be an ENV VAR NAME');
  expect(r.errors.join()).toContain('embeds credentials');
});

test('duplicate ids, dangling edges, denied-without-capability all surface together', () => {
  const g = goodGraphV2();
  g.nodes.push({ id: 'expense', type: 'data', label: 'dup' });
  g.edges.push({ id: 'e9', from: 'sess_sf_sales', to: 'nowhere', type: 'does', data: { catalog: 'x.y' } });
  g.edges.push({ id: 'e3', from: 'sess_sf_admin', to: 'expense', type: 'denied' });
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('nodes.expense: duplicate node id');
  expect(r.errors.join()).toContain("edges.e9.to: unknown node 'nowhere'");
  expect(r.errors.join()).toContain('edges.e3: duplicate edge id');
  expect(r.errors.join()).toContain('denied edges require data.capability');
});

test('status enums and numeric bounds are checked', () => {
  const g = goodGraphV2();
  node(g, 'sess_sf_sales').steps = { status: 'someday' } as unknown as { status: 'planned' };
  (node(g, 'sess_siebel_admin').snapshot as { status: string }).status = 'maybe';
  node(g, 'sess_sf_sales').timing = { plannedMs: -5 };
  g.edges[1]!.data = { catalog: 'expense.submit', deltaMs: -1 };
  g.edges[4]!.data = { ...g.edges[4]!.data, frequency: 0 };
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('steps.status: one of planned|captured');
  expect(r.errors.join()).toContain('snapshot.status: one of planned|captured');
  expect(r.errors.join()).toContain('timing.plannedMs: must be > 0');
  expect(r.errors.join()).toContain('deltaMs: must be >= 0');
  expect(r.errors.join()).toContain('frequency: must be >= 1');
});

test('start/end nodes may omit labels; every other node must have one', () => {
  const g = goodGraphV2();
  node(g, 'sess_sf_sales').label = '';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('nodes.sess_sf_sales.label: required');
  expect(r.errors.join()).not.toContain('nodes.start.label');
});
