/**
 * PG-3 — plan graph → journey skeleton + session policies (pure half).
 */
import { test, expect } from '@playwright/test';
import { toJourney, sessionPoliciesFromGraph } from '../../src/graph/toJourney';
import { goodGraph } from '../helpers/sampleGraph';

const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest'];

test('exports the spine in order: bound step, deny after its source, plan placeholders', () => {
  const r = toJourney(goodGraph(), { personaIds: PERSONAS });
  expect(r.journey.journey).toBe('expense_to_siebel');
  expect(r.journey.actors).toEqual({ submitter: 'sales_user', approver: 'admin' });
  expect(r.journey.steps).toEqual([
    { actor: 'submitter', do: 'expense.submit' },
    { deny: { actor: 'submitter', capability: 'expense.approve' } },
    { actor: 'approver', do: 'plan.approve' },
    { actor: 'approver', do: 'plan.verify' },
  ]);
  expect(r.unboundSteps).toEqual(['plan.approve', 'plan.verify']);
  expect(r.warnings.join()).toContain('unbound plan steps');
});

test('session policies derive from limited systems and the actors that touch them', () => {
  const r = toJourney(goodGraph(), { personaIds: PERSONAS });
  expect(r.sessionPolicies.groups).toEqual([
    { system: 'siebel', maxConcurrent: 1, personas: ['admin'] },
  ]);

  const g = goodGraph();
  g.nodes.push({ id: 'audit', type: 'action', label: 'Audit in Siebel', system: 'siebel', actor: 'submitter' });
  g.edges = g.edges.filter((e) => e.id !== 'e5');
  g.edges.push({ id: 'e5', from: 'verify', to: 'audit', type: 'next' });
  g.edges.push({ id: 'e6', from: 'audit', to: 'done', type: 'next' });
  const r2 = toJourney(g, { personaIds: PERSONAS });
  expect(r2.sessionPolicies.groups[0]!.personas.sort()).toEqual(['admin', 'sales_user']);
  expect(r2.warnings.join()).toContain("system 'siebel' allows 1 session(s) but 2 personas");
  expect(r2.warnings.join()).toContain('logout-to-comply');
});

test('deny target rides the edge recordRef', () => {
  const g = goodGraph();
  g.edges.find((e) => e.id === 'e3')!.data!.recordRef = '{ref:expense.id}';
  const r = toJourney(g, { personaIds: PERSONAS });
  expect(r.journey.steps[1]).toEqual({
    deny: { actor: 'submitter', capability: 'expense.approve', target: '{ref:expense.id}' },
  });
});

test('branching, cycles, multiple starts, and actor-less nodes are refused loudly', () => {
  const branch = goodGraph();
  branch.edges.push({ id: 'b1', from: 'submit', to: 'verify', type: 'next' });
  expect(() => toJourney(branch)).toThrow(/node 'submit' branches into.*split each decision path/);

  const cycle = goodGraph();
  cycle.edges.push({ id: 'c1', from: 'verify', to: 'submit', type: 'next' });
  expect(() => toJourney(cycle)).toThrow(/branches into|cycle detected/);

  const twoStarts = goodGraph();
  twoStarts.nodes.push({ id: 'other', type: 'action', label: 'Loose', actor: 'approver' });
  expect(() => toJourney(twoStarts)).toThrow(/multiple spine starts/);

  const noActor = goodGraph();
  delete noActor.nodes.find((n) => n.id === 'approve')!.actor;
  expect(() => toJourney(noActor)).toThrow(/node 'approve'.*has no actor/);
});

test('an invalid graph never exports; an invalid persona binding is caught', () => {
  const bad = goodGraph();
  bad.edges.push({ id: 'x', from: 'submit', to: 'ghost', type: 'next' });
  expect(() => toJourney(bad)).toThrow(/graph invalid/);

  expect(() => toJourney(goodGraph(), { personaIds: ['admin'] })).toThrow(/unknown persona 'sales_user'/);
});

test('sessionPoliciesFromGraph ignores unlimited systems and empty lanes', () => {
  const g = goodGraph();
  delete g.systems.siebel!.sessionPolicy;
  expect(sessionPoliciesFromGraph(g).groups).toEqual([]);

  const g2 = goodGraph();
  g2.nodes.forEach((n) => { if (n.system === 'siebel') n.system = 'sf'; });
  expect(sessionPoliciesFromGraph(g2).groups).toEqual([]);
});
