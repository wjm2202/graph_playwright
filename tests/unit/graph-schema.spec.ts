/**
 * PG-0 — process-graph validation: every rule, every error surfaced at once.
 */
import { test, expect } from '@playwright/test';
import { validateGraph } from '../../src/graph/schema';
import { goodGraph } from '../helpers/sampleGraph';

test('a well-formed graph passes with zero errors', () => {
  expect(validateGraph(goodGraph()).errors).toEqual([]);
});

// (Seed-file drift guarding moved to graph-v2.spec — the shipped seed is now
//  the v2 relation form; goodGraph() here remains the v1 sample for v1-rule
//  and upgrade-converter coverage.)

test('schema tag, id grammar, and object shape are enforced', () => {
  expect(validateGraph(null).errors).toEqual(['graph must be an object']);
  const g = goodGraph() as unknown as Record<string, unknown>;
  g.schema = 'nope';
  g.id = 'Bad Id';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain("schema: must be 'process-graph/1'");
  expect(r.errors.join()).toContain('id: lower_snake_case');
});

test('system rules: label, kind, urlEnv name-shape, sessionPolicy bounds', () => {
  const g = goodGraph();
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
  const g = goodGraph();
  g.nodes[1]!.system = 'sap';
  g.nodes[1]!.actor = 'ghost';
  g.nodes[1]!.account = { usernameEnv: 'hunter2!' };
  g.nodes[2]!.url = 'https://admin:secret@siebel.corp/app';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain("nodes.submit.system: 'sap' not in systems");
  expect(r.errors.join()).toContain("nodes.submit.actor: 'ghost' not in actors");
  expect(r.errors.join()).toContain('usernameEnv: must be an ENV VAR NAME');
  expect(r.errors.join()).toContain('embeds credentials');
});

test('duplicate ids, dangling edges, deny-without-capability all surface together', () => {
  const g = goodGraph();
  g.nodes.push({ id: 'submit', type: 'action', label: 'dup' });
  g.edges.push({ id: 'e9', from: 'submit', to: 'nowhere', type: 'next' });
  g.edges.push({ id: 'e3', from: 'submit', to: 'approve', type: 'deny' });
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('nodes.submit: duplicate node id');
  expect(r.errors.join()).toContain("edges.e9.to: unknown node 'nowhere'");
  expect(r.errors.join()).toContain('edges.e3: duplicate edge id');
  expect(r.errors.join()).toContain('deny edges require data.capability');
});

test('status enums and numeric bounds are checked', () => {
  const g = goodGraph();
  (g.nodes[1]!.steps as { status: string }).status = 'someday';
  (g.nodes[2]!.snapshot as { status: string }).status = 'maybe';
  g.nodes[1]!.timing = { plannedMs: -5 };
  g.edges[1]!.data = { deltaMs: -1 };
  g.edges[3]!.data = { ...g.edges[3]!.data, frequency: 0 };
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('steps.status: one of planned|captured');
  expect(r.errors.join()).toContain('snapshot.status: one of planned|captured');
  expect(r.errors.join()).toContain('timing.plannedMs: must be > 0');
  expect(r.errors.join()).toContain('deltaMs: must be >= 0');
  expect(r.errors.join()).toContain('frequency: must be >= 1');
});

test('start/end nodes may omit labels; action nodes may not', () => {
  const g = goodGraph();
  g.nodes[1]!.label = '';
  const r = validateGraph(g);
  expect(r.errors.join()).toContain('nodes.submit.label: required');
  expect(r.errors.join()).not.toContain('nodes.start.label');
});
