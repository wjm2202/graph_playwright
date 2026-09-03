/**
 * Persona matrix (owner, 2026-09-02): an ADO pre-req "Personas who can
 * perform this action: A, B, C" means the flow must be proven for EACH of
 * them. `graph.alternatives` declares the matrix; expandVariants() turns it
 * into bindings (default first); tests/e2e/graphs.spec.ts registers one test
 * per binding (proven in suites.spec.ts, which lists the real suite);
 * runGraph takes the binding as actorOverrides; the gap engine checks the
 * alternatives against personas.json like it checks the defaults.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';
import { expandVariants, MAX_VARIANTS } from '../../src/graph/toJourney';
import { runGraph } from '../../src/graph/run';
import { computeGaps } from '../../src/graph/gaps';
import { StepCatalog } from '../../src/journeys/catalog';
import type { CastLike } from '../../src/journeys/runner';
import { goodGraphV2 } from '../helpers/sampleGraph';

function withMatrix(): ProcessGraph {
  const g = goodGraphV2();
  g.alternatives = { submitter: ['lead_creator', 'credit_approver'] };
  return g;
}

test.describe('schema', () => {
  test('alternatives must name a real alias, real ids, no duplicates, and not the default', () => {
    const g = withMatrix();
    expect(validateGraph(g).ok).toBe(true);
    g.alternatives = { ghost: ['admin'], submitter: ['sales_user', 'admin', 'admin'], approver: [] };
    const errors = validateGraph(g).errors.join('\n');
    expect(errors).toMatch(/alternatives.ghost: alias is not in actors/);
    expect(errors).toMatch(/alternatives.submitter: 'sales_user' is already the default persona/);
    expect(errors).toMatch(/alternatives.submitter: 'admin' listed twice/);
    expect(errors).toMatch(/alternatives.approver: non-empty array/);
  });
});

test.describe('expandVariants', () => {
  test('no matrix → the single default binding', () => {
    expect(expandVariants(goodGraphV2())).toEqual([{ id: 'default', label: 'default', actors: goodGraphV2().actors }]);
  });

  test('one axis → default first, then each alternative, ids from the persona', () => {
    const v = expandVariants(withMatrix());
    expect(v.map((x) => x.id)).toEqual(['default', 'lead_creator', 'credit_approver']);
    expect(v[1]).toEqual({ id: 'lead_creator', label: 'submitter → lead_creator', actors: { submitter: 'lead_creator', approver: 'admin', siebel_approver: 'siebel_admin' } });
  });

  test('two axes combine as a product; an absurd matrix is refused', () => {
    const g = withMatrix();
    g.alternatives!.approver = ['sales_user'];
    const v = expandVariants(g);
    expect(v.map((x) => x.id)).toEqual(['default', 'sales_user', 'lead_creator', 'lead_creator__sales_user', 'credit_approver', 'credit_approver__sales_user']);
    expect(v[3]!.label).toBe('submitter → lead_creator, approver → sales_user');
    g.alternatives = { submitter: Array.from({ length: MAX_VARIANTS }, (_, i) => `p${i}`) };
    expect(() => expandVariants(g)).toThrow(/persona matrix has 25 variants \(max 24\)/);
  });
});

test('runGraph with actorOverrides runs the same walk as the other persona; an unknown alias is refused', async () => {
  const logins: string[] = [];
  const cast: CastLike = {
    async as(personaId) { logins.push(personaId); return { url: () => 'about:blank' } as unknown as Page; },
    async deny(personaId) { logins.push(`deny:${personaId}`); },
  };
  const catalog = new StepCatalog()
    .register('expense.submit', async ({ produce }) => { produce('expense', { id: 'a03000000000001AAA', sobject: 'Expense__c' }); })
    .register('expense.approve', async () => {})
    .register('siebel.verify_expense', async () => {})
    .registerDeny('expense.approve', () => ({ ui: async () => { /* control absent → refusal proven */ } }));
  const g = withMatrix();
  const r = await runGraph(g, { cast, catalog, personaIds: ['sales_user', 'admin', 'siebel_admin', 'lead_creator', 'credit_approver'], actorOverrides: { submitter: 'lead_creator' }, variant: 'lead_creator' });
  expect(r.error).toBeUndefined();
  expect(logins.filter((l) => !l.startsWith('deny:'))).toEqual(['lead_creator', 'admin', 'siebel_admin']);
  expect(logins.some((l) => l === 'deny:lead_creator')).toBe(true);
  // The graph on disk keeps its matrix and default binding — the variant never leaks back.
  expect(r.graph.actors.submitter).toBe('sales_user');
  expect(r.graph.alternatives).toEqual({ submitter: ['lead_creator', 'credit_approver'] });
  await expect(runGraph(g, { cast, catalog, actorOverrides: { nobody: 'admin' } })).rejects.toThrow(/actorOverrides: alias 'nobody' is not in the graph's actors/);
});

test('the gap engine checks alternatives against the roster', () => {
  const g = withMatrix();
  const gaps = computeGaps(g, { knownPersonas: ['sales_user', 'admin', 'siebel_admin', 'lead_creator'] });
  const unbound = gaps.filter((x) => x.kind === 'role_unbound');
  expect(unbound.map((x) => x.at)).toEqual(['submitter:credit_approver']);
  expect(unbound[0]!.question).toMatch(/may also be played by 'credit_approver' \(persona matrix\)/);
});
