/**
 * S-GRAPH-2 — the v2 relation model, audited end to end:
 * validation rules, the v1→v2 upgrade converter, the login-chain journey
 * walker, capture→upgrade chaining, mermaid rendering, and substrate encoding.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { validateGraph } from '../../src/graph/schema';
import { upgradeGraph } from '../../src/graph/upgrade';
import { toJourney } from '../../src/graph/toJourney';
import { toMermaid } from '../../src/graph/mermaid';
import { toBatch } from '../../src/graph/toBatch';
import { fromDistillation } from '../../src/graph/fromDistillation';
import { distill } from '../../src/pipeline/distill';
import { readTrace } from '../../src/pipeline/traceReader';
import { goodGraph, goodGraphV2 } from '../helpers/sampleGraph';

const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest', 'siebel_admin'];

test.describe('v2 validation', () => {
  test('the v2 sample and the shipped seed are valid and identical (drift guard)', () => {
    expect(validateGraph(goodGraphV2()).errors).toEqual([]);
     
    const shipped = require(path.resolve(__dirname, '../../journeys/graphs/expense_to_siebel.graph.json'));
    expect(validateGraph(shipped).errors).toEqual([]);
    expect(shipped).toEqual(goodGraphV2());
  });

  test('v2 rules: session lane, login_as target, does naming, denied capability', () => {
    const g = goodGraphV2();
    delete g.nodes.find((n) => n.id === 'sess_sf_sales')!.system;
    g.edges.push({ id: 'x1', from: 'start', to: 'expense', type: 'login_as' });
    g.edges.push({ id: 'x2', from: 'sess_sf_admin', to: 'expense', type: 'does' });
    g.edges.push({ id: 'x3', from: 'sess_sf_admin', to: 'expense', type: 'denied' });
    const r = validateGraph(g);
    expect(r.errors.join()).toContain('session nodes require a system');
    expect(r.errors.join()).toContain("login_as must land on a session node (got 'data')");
    expect(r.errors.join()).toContain('does edges need data.catalog');
    expect(r.errors.join()).toContain('deny edges require data.capability');
  });
});

test.describe('v2 journey walker', () => {
  test('login chain → per-session does/denied become the journey, in authored order', () => {
    const r = toJourney(goodGraphV2(), { personaIds: PERSONAS });
    expect(r.journey.actors).toEqual({
      submitter: 'sales_user',
      approver: 'admin',
      siebel_approver: 'siebel_admin',
    });
    expect(r.journey.steps).toEqual([
      {
        actor: 'submitter', do: 'expense.submit', with: { record: 'Expense record' },
        expect: { expects: [{ id: 'expense_saved', kind: 'api.record_exists', target: 'Expense__c', note: 'expense row persisted' }] },
      },
      { deny: { actor: 'submitter', capability: 'expense.approve' } },
      {
        actor: 'approver', do: 'expense.approve', with: { record: 'Expense record' },
        expect: { expects: [{ id: 'expense_approved', kind: 'api.field_equals', target: 'Expense__c', value: 'Status__c=Approved' }] },
      },
      // The Siebel step is a DIFFERENT actor: same human, different system,
      // different credentials and auth method.
      { actor: 'siebel_approver', do: 'siebel.verify_expense', with: { record: 'Expense record' } },
    ]);
    expect(r.unboundSteps).toEqual([]);
    expect(r.requires).toEqual([]);
    expect(r.sessionPolicies.groups).toEqual([
      { system: 'siebel', maxConcurrent: 1, personas: ['siebel_admin'] },
    ]);
    // one persona on a max-1 system → within policy, so no logout-to-comply warning:
    expect(r.warnings.filter((w) => w.includes('logout-to-comply'))).toEqual([]);
  });

  test('requires edges surface as prerequisites with guidance', () => {
    const g = goodGraphV2();
    g.nodes.push({ id: 'seeded', type: 'checkpoint', label: 'Expense data seeded' });
    g.edges.push({ id: 'r1', from: 'sess_sf_sales', to: 'seeded', type: 'requires' });
    const r = toJourney(g, { personaIds: PERSONAS });
    expect(r.requires).toEqual([{ from: 'sess_sf_sales', to: 'seeded' }]);
    expect(r.warnings.join()).toContain('prerequisites declared (1)');
  });

  test('walker guards: missing start, branching logins, cycles, actor-less sessions, empty', () => {
    const noStart = goodGraphV2();
    noStart.nodes = noStart.nodes.filter((n) => n.id !== 'start');
    noStart.edges = noStart.edges.filter((e) => e.from !== 'start');
    expect(() => toJourney(noStart)).toThrow(/need a 'start' node/);

    const branch = goodGraphV2();
    branch.edges.push({ id: 'b1', from: 'start', to: 'sess_sf_admin', type: 'login_as' });
    expect(() => toJourney(branch)).toThrow(/outgoing login_as edges/);

    const cyc = goodGraphV2();
    cyc.edges.push({ id: 'c1', from: 'sess_siebel_admin', to: 'sess_sf_sales', type: 'login_as' });
    expect(() => toJourney(cyc)).toThrow(/login_as cycle/);

    const noActor = goodGraphV2();
    delete noActor.nodes.find((n) => n.id === 'sess_sf_admin')!.actor;
    expect(() => toJourney(noActor)).toThrow(/session 'sess_sf_admin' has no actor/);

    const empty = goodGraphV2();
    empty.edges = empty.edges.filter((e) => e.type === 'login_as');
    expect(() => toJourney(empty)).toThrow(/no executable steps/);
  });

  test('does without catalog exports a plan placeholder and flags it', () => {
    const g = goodGraphV2();
    delete g.edges.find((e) => e.id === 'e7')!.data!.catalog;
    const r = toJourney(g, { personaIds: PERSONAS });
    expect(r.journey.steps[3]).toMatchObject({ actor: 'siebel_approver', do: 'plan.e7' });
    expect(r.unboundSteps).toEqual(['plan.e7']);
    expect(r.warnings.join()).toContain('unbound plan steps');
  });
});

test.describe('v1 → v2 upgrade', () => {
  test('activity nodes become sessions + does relations; deny/handoff become denied/touches', () => {
    const { graph, warnings } = upgradeGraph(goodGraph());
    expect(graph.schema).toBe('process-graph/2');
    expect(validateGraph(graph).errors).toEqual([]);

    const sessions = graph.nodes.filter((n) => n.type === 'session').map((n) => n.id);
    expect(sessions).toEqual(['sess_sf_submitter', 'sess_sf_approver', 'sess_siebel_approver']);
    expect(graph.nodes.some((n) => n.type === 'data' && n.label.includes('a03xx0000012AbCDEF'))).toBe(true);

    const logins = graph.edges.filter((e) => e.type === 'login_as').map((e) => `${e.from}→${e.to}`);
    expect(logins).toEqual([
      'start→sess_sf_submitter',
      'sess_sf_submitter→sess_sf_approver',
      'sess_sf_approver→sess_siebel_approver',
    ]);
    expect(graph.edges.filter((e) => e.type === 'does')).toHaveLength(3);
    expect(graph.edges.filter((e) => e.type === 'denied')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.type === 'touches')).toHaveLength(2);
    expect(warnings.join()).toContain('steps/snapshot/planned timing');
  });

  test('an upgraded graph walks into the same journey shape', () => {
    const { graph } = upgradeGraph(goodGraph());
    const r = toJourney(graph, { personaIds: PERSONAS });
    expect(r.journey.steps.map((s) => ('deny' in s ? 'deny' : s.do))).toEqual([
      'expense.submit', 'deny', 'plan.e5', 'plan.e6',
    ]);
    expect(r.sessionPolicies.groups[0]).toMatchObject({ system: 'siebel', maxConcurrent: 1 });
  });

  test('upgrade refuses invalid input and passes v2 through unchanged', () => {
    const bad = goodGraph();
    bad.edges.push({ id: 'x', from: 'submit', to: 'ghost', type: 'next' });
    expect(() => upgradeGraph(bad)).toThrow(/cannot upgrade an invalid graph/);

    const already = upgradeGraph(goodGraphV2());
    expect(already.graph).toEqual(goodGraphV2());
    expect(already.warnings.join()).toContain('already process-graph/2');
  });

  test('capture chain: fixture trace → distill → v1 graph → upgrade → valid v2', () => {
    const d = distill(readTrace(path.resolve(__dirname, '../fixtures/trace-demo/trace.zip')).events);
    const v1 = fromDistillation(d, { graphId: 'fixture_demo_graph', actors: { main: 'sales_user' } });
    const { graph } = upgradeGraph(v1);
    expect(validateGraph(graph).errors).toEqual([]);
    expect(graph.nodes.filter((n) => n.type === 'session')).toHaveLength(1);
    expect(graph.edges.filter((e) => e.type === 'does').length).toBeGreaterThanOrEqual(4);
  });
});

test.describe('lead_to_customer (shipped, owner-dictated)', () => {
   
  const leadGraph = () => require(path.resolve(__dirname, '../../journeys/graphs/lead_to_customer.graph.json'));
   
  const personaIds = () => Object.keys(require(path.resolve(__dirname, '../../personas.json')).personas);

  test('validates, and every actor maps to a real persona', () => {
    expect(validateGraph(leadGraph()).errors).toEqual([]);
    const g = leadGraph();
    for (const persona of Object.values(g.actors)) expect(personaIds()).toContain(persona);
  });

  test('walks into the multi-role journey with per-state oracles and the Siebel policy', () => {
    const r = toJourney(leadGraph(), { personaIds: personaIds() });
    // Budgets/oracles below reflect the 2026-09-01 grillme session (owner-
    // answered): SF writes are synchronous (explicit 10s), the Siebel record
    // is proven on-screen (DB not queryable), endpoint_traffic confirmed.
    expect(r.journey.steps).toEqual([
      {
        actor: 'lead_creator', do: 'lead.create', with: { record: 'Lead record' },
        expect: { expects: [{ id: 'lead_created', kind: 'api.record_exists', target: 'Lead', note: 'lead row persisted', timeoutMs: 10_000 }] },
      },
      {
        actor: 'lead_approver', do: 'lead.progress_to_potential', with: { record: 'Lead record' },
        expect: { expects: [{ id: 'lead_potential', kind: 'api.field_equals', target: 'Lead', value: 'Status=Potential', note: 'progressed by the approver', timeoutMs: 10_000 }] },
      },
      {
        actor: 'credit_approver', do: 'credit.check', with: { record: 'Lead record' },
        expect: { expects: [{ id: 'credit_approved', kind: 'api.field_equals', target: 'Lead', value: 'Credit_Status__c=Approved', note: 'credit check outcome persisted', timeoutMs: 10_000 }] },
      },
      {
        actor: 'customer_approver', do: 'lead.approve_to_customer', with: { record: 'Customer record' },
        expect: {
          expects: [
            { id: 'customer_created', kind: 'api.record_exists', target: 'Account', note: 'conversion produced the customer account', timeoutMs: 10_000 },
            { id: 'conversion_toast', kind: 'ui.toast', value: 'converted', note: 'UI confirms the conversion' },
          ],
        },
      },
      {
        actor: 'siebel_admin', do: 'siebel.check_customer', with: { record: 'Customer record (Siebel)' },
        expect: { expects: [{ id: 'customer_visible_in_ui', kind: 'ui.text', value: 'E2E_', note: 'siebel_admin sees the E2E-prefixed customer name in the Siebel UI (DB not queryable — verify via UI)' }] },
      },
      {
        actor: 'siebel_admin', do: 'assert.chk_customer',
        // Async replication: the Siebel oracle POLLS — 2 min budget, 5s interval.
        // Plus the (grillme-confirmed) gateway-log check: did traffic actually
        // hit create_customer_v2?
        expect: { expects: [
          { id: 'customer_in_siebel', kind: 'api.record_exists', target: 'Customer', note: 'in Siebel = pass; missing = the SF→Siebel integration failed', timeoutMs: 120_000, pollMs: 5000 },
          { id: 'endpoint_traffic', kind: 'log.traffic', target: 'log_gateway', value: 'create_customer_v2', timeoutMs: 60_000, pollMs: 5000, note: 'draft — confirm the log system + search term' },
        ] },
      },
    ]);
    // assert.* steps are runner-built-in (central oracle evaluation) — never unbound.
    expect(r.unboundSteps).toEqual([]);
    expect(r.stepEdgeIds).toEqual(['e2', 'e4', 'e6', 'e8', 'e11', 'e12']);
    expect(r.sessionPolicies.groups).toEqual([{ system: 'siebel', maxConcurrent: 1, personas: ['siebel_admin'] }]);
  });

  test('expectation validation: kinds, requirements, uniqueness, results', () => {
    const g = leadGraph();
    const lead = g.nodes.find((n: { id: string }) => n.id === 'lead');
    lead.expects.push({ id: 'lead_created', kind: 'ui.wizardry' }); // dup id + bad kind
    lead.expects.push({ id: 'no_target', kind: 'api.record_exists' });
    lead.expects.push({ id: 'no_value', kind: 'ui.text', target: 'x' });
    lead.expects.push({ id: 'bad_result', kind: 'ui.visible', target: 'x', lastResult: { status: 'meh', at: 'now' } });
    const r = validateGraph(g);
    expect(r.errors.join()).toContain('duplicate expectation id');
    expect(r.errors.join()).toContain('ui.visible|ui.text|ui.toast|ui.url|api.record_exists|api.field_equals');
    expect(r.errors.join()).toContain('api.* expectations need target');
    expect(r.errors.join()).toContain('ui.text needs value');
    expect(r.errors.join()).toContain('lastResult.status: pass|fail');
  });
});

test.describe('v2 rendering + encoding', () => {
  test('mermaid: stadium sessions, relation labels, dashed denials', () => {
    const mm = toMermaid(goodGraphV2());
    expect(mm).toContain('sess_sf_sales([Salesforce · submitter])');
    expect(mm).toContain('|login as submitter|');
    expect(mm).toContain('|expense.submit · submit expense|');
    expect(mm).toContain('-.->|deny expense.approve|');
  });

  test('toBatch: denied capabilities and data-node records reach coverage', () => {
    const b = toBatch(goodGraphV2());
    expect(b.atoms[1]!.payload).toContain('denials probed: expense.approve');
    expect(b.atoms[1]!.payload).toContain('Expense record');
  });
});
