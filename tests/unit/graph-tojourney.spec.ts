/**
 * PG-3 — plan graph → journey skeleton + session policies (pure half).
 * (The walk itself — chain order, ports, oracles, guards — is audited in
 *  graph-v2.spec; this file owns the policy/refusal half.)
 */
import { test, expect } from '@playwright/test';
import { toJourney, sessionPoliciesFromGraph } from '../../src/graph/toJourney';
import { goodGraphV2 } from '../helpers/sampleGraph';

const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest', 'siebel_admin'];

test('exports the chain in order: bound steps, the deny after its session, plan placeholders', () => {
  const g = goodGraphV2();
  delete g.edges.find((e) => e.id === 'e5')!.data!.catalog;
  const r = toJourney(g, { personaIds: PERSONAS });
  expect(r.journey.journey).toBe('expense_to_siebel');
  expect(r.journey.steps.map((s) => ('deny' in s ? `deny:${s.deny.capability}` : s.do))).toEqual([
    'expense.submit', 'deny:expense.approve', 'plan.e5', 'siebel.verify_expense',
  ]);
  expect(r.unboundSteps).toEqual(['plan.e5']);
  expect(r.warnings.join()).toContain('unbound plan steps');
});

test('session policies derive from limited systems and the actors that touch them', () => {
  const r = toJourney(goodGraphV2(), { personaIds: PERSONAS });
  expect(r.sessionPolicies.groups).toEqual([
    { system: 'siebel', maxConcurrent: 1, personas: ['siebel_admin'] },
  ]);

  // A second role in the max-1 system: Cast must logout-to-comply between them.
  const g = goodGraphV2();
  g.nodes.push({ id: 'sess_siebel_sales', type: 'session', label: 'Siebel · submitter', system: 'siebel', actor: 'submitter' });
  const r2 = toJourney(g, { personaIds: PERSONAS });
  expect(r2.sessionPolicies.groups[0]!.personas.sort()).toEqual(['sales_user', 'siebel_admin']);
  expect(r2.warnings.join()).toContain("system 'siebel' allows 1 session(s) but 2 personas");
  expect(r2.warnings.join()).toContain('logout-to-comply');
});

test('deny target rides the edge recordRef', () => {
  const g = goodGraphV2();
  g.edges.find((e) => e.id === 'e3')!.data!.recordRef = '{ref:expense.id}';
  const r = toJourney(g, { personaIds: PERSONAS });
  expect(r.journey.steps[1]).toEqual({
    deny: { actor: 'submitter', capability: 'expense.approve', target: '{ref:expense.id}' },
  });
});

test('an invalid graph never exports; an invalid persona binding is caught', () => {
  const bad = goodGraphV2();
  bad.edges.push({ id: 'x', from: 'sess_sf_sales', to: 'ghost', type: 'next' });
  expect(() => toJourney(bad)).toThrow(/graph invalid/);

  expect(() => toJourney(goodGraphV2(), { personaIds: ['admin'] })).toThrow(/unknown persona 'sales_user'/);
});

test('sessionPoliciesFromGraph ignores unlimited systems and empty lanes', () => {
  const g = goodGraphV2();
  delete g.systems.siebel!.sessionPolicy;
  expect(sessionPoliciesFromGraph(g).groups).toEqual([]);

  const g2 = goodGraphV2();
  g2.nodes.forEach((n) => { if (n.system === 'siebel') n.system = 'sf'; });
  expect(sessionPoliciesFromGraph(g2).groups).toEqual([]);
});
