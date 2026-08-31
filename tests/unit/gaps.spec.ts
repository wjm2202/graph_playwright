/**
 * S6 — the grillme engine: gap detection on drafts, and answer write-back
 * that shrinks the gap list monotonically toward zero.
 */
import { test, expect } from '@playwright/test';
import { computeGaps, applyAnswers } from '../../src/graph/gaps';
import { adoCaseToGraph, parseAdoPaste } from '../../src/graph/fromAdo';
import { validateGraph } from '../../src/graph/schema';
import { goodGraphV2 } from '../helpers/sampleGraph';

const KNOWN = ['lead_creator', 'lead_approver', 'siebel_admin', 'sales_user', 'admin'];

const draft = () =>
  adoCaseToGraph(
    parseAdoPaste([
      'Title: Lead flow',
      '1. As a lead creator, create a lead | Lead record is created',
      '2. As a lead approver, approve the lead | Toast shows "Approved"',
    ].join('\n')),
    { knownPersonas: KNOWN },
  ).graph;

test('an ADO draft is fully interrogated: captures, urls, drafts, timeouts, deny coverage', () => {
  const gaps = computeGaps(draft(), { knownPersonas: KNOWN });
  const kinds = gaps.map((g) => g.kind);
  expect(kinds).toContain('not_captured');     // nothing recorded yet
  expect(kinds).toContain('session_no_url');   // pre-navigation unknown
  expect(kinds).toContain('draft_oracle');     // the two guessed checks
  expect(kinds).toContain('api_no_timeout');   // record_exists on default budget
  expect(kinds).toContain('no_deny_coverage'); // two roles, no negative test
  expect(kinds).not.toContain('role_unbound'); // both roles known
  expect(kinds).not.toContain('does_unbound'); // convention named everything
  for (const g of gaps) expect(g.question.length).toBeGreaterThan(10); // askable as-is
});

test('unknown personas surface as role_unbound with the roster as options', () => {
  const gaps = computeGaps(draft(), { knownPersonas: ['sales_user'] });
  const role = gaps.find((g) => g.kind === 'role_unbound')!;
  expect(role).toBeDefined();
  expect(role.options).toEqual(['sales_user']);
});

test('answers shrink the gap list, and the applied graph stays valid', () => {
  const g = draft();
  const before = computeGaps(g, { knownPersonas: KNOWN });

  const leadExpects = g.nodes.find((n) => n.id === 'lead')!.expects!;
  const apiCheck = leadExpects.find((x) => x.kind === 'api.record_exists')!;
  const { graph: after, changes } = applyAnswers(g, [
    { op: 'confirmExpect', node: 'lead', id: apiCheck.id },
    { op: 'setOracleBudget', node: 'lead', id: apiCheck.id, timeoutMs: 120_000, pollMs: 5000 },
    { op: 'setUrl', node: 'sess_lead_creator', url: '/lightning/o/Lead/list' },
    { op: 'addDeny', from: 'sess_lead_creator', to: 'lead', capability: 'lead.approve' },
  ]);
  expect(changes).toHaveLength(4);
  expect(validateGraph(after).errors).toEqual([]);

  const remaining = computeGaps(after, { knownPersonas: KNOWN });
  expect(remaining.length).toBeLessThan(before.length);
  const kinds = remaining.map((x) => x.kind);
  expect(kinds).not.toContain('no_deny_coverage');
  expect(kinds).not.toContain('api_no_timeout');
  // The source graph was untouched (pure):
  expect(g.edges.some((e) => e.type === 'denied')).toBe(false);
});

test('a completed, captured graph asks almost nothing', () => {
  const g = goodGraphV2();
  for (const n of g.nodes) {
    if (n.type === 'session') {
      n.steps = { status: 'captured', journeyId: 'expense_v2' };
      n.url = '/lightning/page';
    }
  }
  const gaps = computeGaps(g, { knownPersonas: KNOWN });
  const kinds = gaps.map((x) => x.kind);
  expect(kinds).not.toContain('not_captured');
  expect(kinds).not.toContain('no_deny_coverage'); // e3 denied edge exists
  expect(kinds).not.toContain('no_session_policy'); // siebel policy declared
  expect(kinds).not.toContain('draft_oracle');
  // Only the api timeout question remains — expense checks ride the default:
  expect([...new Set(kinds)]).toEqual(['api_no_timeout']);
});

test('bad ops fail loudly and never write', () => {
  const g = draft();
  expect(() => applyAnswers(g, [{ op: 'setCatalog', edge: 'ghost', name: 'x.y' }])).toThrow(/unknown edge/);
  expect(() => applyAnswers(g, [{ op: 'confirmExpect', node: 'lead', id: 'ghost' }])).toThrow(/unknown expectation/);
  expect(() => applyAnswers(g, [{ op: 'bindRole', alias: 'ghost', personaId: 'admin' }])).toThrow(/unknown role/);
});
