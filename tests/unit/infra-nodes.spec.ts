/**
 * S7 — infra nodes (db / logger / api) as EVIDENCE SOURCES:
 * db.query is only legal against a QUERYABLE db node (many DBs can't be
 * reached — the schema says so out loud); log.traffic searches a logger for
 * traffic (e.g. an endpoint name); api nodes name integration hops like
 * create_customer_v2. Backend kinds poll through the same oracle seam.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';
import { toJourney } from '../../src/graph/toJourney';
import { evaluateOracles } from '../../src/journeys/oracles';
import { computeGaps } from '../../src/graph/gaps';

const NO_PAGE = undefined as unknown as Page;

/** SF session creates a customer → create_customer_v2 → Siebel DB; checkpoint
 *  verifies via db.query (DB is queryable) and log.traffic (endpoint hit). */
const infraGraph = (): ProcessGraph => ({
  schema: 'process-graph/2',
  id: 'integration_check',
  systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
  actors: { operator: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_operator', type: 'session', label: 'Salesforce · operator', system: 'sf', actor: 'operator' },
    { id: 'customer', type: 'data', label: 'Customer record' },
    { id: 'api_create_customer_v2', type: 'api', label: 'create_customer_v2', endpoint: { method: 'POST', path: '/services/apexrest/create_customer_v2' } },
    { id: 'db_siebel', type: 'db', label: 'Siebel DB', queryable: true },
    { id: 'log_gateway', type: 'logger', label: 'API gateway logs' },
    {
      id: 'chk_replicated', type: 'checkpoint', label: 'Customer replicated',
      expects: [
        { id: 'row_in_siebel', kind: 'db.query', target: 'db_siebel', value: "S_ORG_EXT WHERE NAME = '{ref:customer.name}'", timeoutMs: 120_000, pollMs: 5000 },
        { id: 'endpoint_hit', kind: 'log.traffic', target: 'log_gateway', value: 'create_customer_v2', timeoutMs: 60_000, pollMs: 5000 },
      ],
    },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'sess_operator', type: 'login_as' },
    { id: 'e2', from: 'sess_operator', to: 'customer', type: 'does', data: { catalog: 'customer.create' } },
    { id: 'e3', from: 'customer', to: 'api_create_customer_v2', type: 'handoff', label: 'replicates via' },
    { id: 'e4', from: 'api_create_customer_v2', to: 'db_siebel', type: 'touches', label: 'writes' },
    { id: 'e5', from: 'api_create_customer_v2', to: 'log_gateway', type: 'touches', label: 'logged in' },
    { id: 'e6', from: 'sess_operator', to: 'chk_replicated', type: 'asserts' },
    { id: 'e7', from: 'sess_operator', to: 'end', type: 'next' },
  ],
});

test.describe('schema', () => {
  test('the integration graph validates — api/db/logger are first-class', () => {
    expect(validateGraph(infraGraph()).errors).toEqual([]);
  });

  test('db.query against a NON-queryable db is refused with the way out', () => {
    const g = infraGraph();
    delete g.nodes.find((n) => n.id === 'db_siebel')!.queryable;
    const errors = validateGraph(g).errors.join('\n');
    expect(errors).toContain("db 'db_siebel' is not queryable");
    expect(errors).toContain('verify via the app API or a logger instead');
  });

  test('db.query/log.traffic must target the right KIND of node, with a value', () => {
    const g = infraGraph();
    const chk = g.nodes.find((n) => n.id === 'chk_replicated')!;
    chk.expects![0]!.target = 'log_gateway'; // db.query at a logger
    expect(validateGraph(g).errors.join()).toContain("target 'log_gateway' is not a db node");

    const g2 = infraGraph();
    g2.nodes.find((n) => n.id === 'chk_replicated')!.expects![1]!.target = 'db_siebel';
    expect(validateGraph(g2).errors.join()).toContain("target 'db_siebel' is not a logger node");

    const g3 = infraGraph();
    delete g3.nodes.find((n) => n.id === 'chk_replicated')!.expects![0]!.value;
    expect(validateGraph(g3).errors.join()).toContain('db.query needs value');
  });

  test('a logger marked not searchable refuses log.traffic; endpoint only on api nodes', () => {
    const g = infraGraph();
    g.nodes.find((n) => n.id === 'log_gateway')!.searchable = false;
    expect(validateGraph(g).errors.join()).toContain("logger 'log_gateway' is marked not searchable");

    const g2 = infraGraph();
    (g2.nodes.find((n) => n.id === 'customer') as { endpoint?: unknown }).endpoint = { method: 'GET' };
    expect(validateGraph(g2).errors.join()).toContain('only api nodes name endpoints');
  });
});

test('walker: infra hops are wiring, not steps — checks ride the asserts edge with budgets intact', () => {
  const r = toJourney(infraGraph(), { personaIds: ['admin'] });
  expect(r.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['customer.create', 'assert.chk_replicated']);
  const assert = r.journey.steps[1] as { expect?: { expects: Record<string, unknown>[] } };
  expect(assert.expect!.expects.map((x) => `${String(x.kind)}@${String(x.target)}`)).toEqual([
    'db.query@db_siebel',
    'log.traffic@log_gateway',
  ]);
  expect(assert.expect!.expects[0]!.timeoutMs).toBe(120_000);
});

test('oracle seam: unbound db/log checks SKIP loudly; bound ones poll to green', async () => {
  const specs = [
    { id: 'row', kind: 'db.query', target: 'db_siebel', value: 'X' },
    { id: 'hit', kind: 'log.traffic', target: 'log_gateway', value: 'create_customer_v2', timeoutMs: 5000, pollMs: 100 },
  ];
  const unbound = await evaluateOracles(NO_PAGE, specs, { args: {} });
  expect(unbound.map((r) => r.status)).toEqual(['skipped', 'skipped']);
  expect(unbound[0]!.message).toContain('DB/log adapter');

  let calls = 0;
  const adapter = async (spec: { kind: string }) => {
    if (spec.kind === 'db.query') return true;
    calls += 1;
    return calls >= 2; // the log entry shows up on the second search
  };
  const bound = await evaluateOracles(NO_PAGE, specs, { args: {} }, adapter);
  expect(bound.map((r) => r.status)).toEqual(['pass', 'pass']);
  expect(calls).toBe(2);
});

test('grillme: backend checks without a budget are asked about — log search included', () => {
  const g = infraGraph();
  delete g.nodes.find((n) => n.id === 'chk_replicated')!.expects![1]!.timeoutMs;
  delete g.nodes.find((n) => n.id === 'chk_replicated')!.expects![1]!.pollMs;
  const gaps = computeGaps(g, { knownPersonas: ['admin'] });
  const budget = gaps.filter((x) => x.kind === 'api_no_timeout');
  expect(budget).toHaveLength(1);
  expect(budget[0]!.at).toBe('chk_replicated.endpoint_hit');
  expect(budget[0]!.question).toContain('log.traffic');
});
