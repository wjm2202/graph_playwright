/**
 * S2.1 — the script ⇄ graph codec (src/graph/script.ts).
 *
 * The contract that matters is the ROUND TRIP: every shipped graph must
 * survive `parseScript(printScript(g).text)` unchanged on everything the
 * script form claims to carry — schema, id, title, systems, actors, tags, the
 * login chain of sessions, the record ledger, the does/denied edges with
 * their catalogs and ports, and every expectation. Ids, positions, capture
 * state and the infra half are NOT claimed; `printScript` has to NAME them in
 * `dropped`, and this spec pins that list exactly so a silent new omission
 * fails here rather than in a planner three sprints later.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { parseScript, printScript, catalogOf } from '../../src/graph/script';
import { loginChain } from '../../src/graph/compose';
import { validateGraph, type Expectation, type PEdge, type PNode, type ProcessGraph } from '../../src/graph/schema';

const SHIPPED = [
  'journeys/graphs/expense_to_siebel.graph.json',
  'journeys/graphs/lead_to_customer.graph.json',
  'journeys/graphs/lead_to_customer_via_ado.graph.json',
  'projects/salesforce/graphs/o2a_tc01_prospect_to_customer.graph.json',
];

function load(file: string): ProcessGraph {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as ProcessGraph;
}

// ---------- the normalising view ----------

/**
 * Everything the script form PROMISES to carry, keyed so that regenerated ids
 * (node ids, edge ids, expectation ids) never enter the comparison: a node is
 * identified by what a reader sees (a session by system+actor, a record by its
 * label), and `after` is resolved through the edge table so a graph that
 * points a check at an edge id compares equal to one that names its catalog.
 */
interface View {
  schema: string;
  id: string;
  title: string;
  systems: Record<string, unknown>;
  actors: Record<string, string>;
  tags: string[];
  sessions: { system: string; actor: string; url: string }[];
  records: { label: string; sobject: string }[];
  steps: { from: string; to: string; type: string; catalog: string; io: string; ioDraft: boolean; capability: string }[];
  expects: Record<string, Omit<Expectation, 'id' | 'note' | 'lastResult'>[]>;
}

/** db./log. oracles need an infra node the script cannot declare. */
const isInfraOracle = (x: Expectation): boolean => x.kind === 'db.query' || x.kind === 'log.traffic';

function view(g: ProcessGraph): View {
  const byId = new Map<string, PNode>(g.nodes.map((n) => [n.id, n]));
  const edgeById = new Map<string, PEdge>(g.edges.map((e) => [e.id, e]));
  const key = (id: string): string => {
    const n = byId.get(id);
    if (!n) return `?:${id}`;
    return n.type === 'session' ? `session:${n.system ?? ''}:${n.actor ?? ''}` : `${n.type}:${n.label}`;
  };
  const after = (a: string | undefined): string => {
    if (a === undefined) return '';
    const e = edgeById.get(a);
    return e ? (e.data?.catalog ?? e.data?.capability ?? a) : a;
  };
  const expects: Record<string, Omit<Expectation, 'id' | 'note' | 'lastResult'>[]> = {};
  for (const n of g.nodes) {
    const list = (n.expects ?? []).filter((x) => !isInfraOracle(x)).map((x) => ({
      kind: x.kind,
      target: x.target ?? '',
      value: x.value ?? '',
      after: after(x.after),
      draft: x.draft === true,
      timeoutMs: x.timeoutMs ?? 0,
      pollMs: x.pollMs ?? 0,
    })) as Omit<Expectation, 'id' | 'note' | 'lastResult'>[];
    if (list.length) expects[key(n.id)] = list;
  }
  return {
    schema: g.schema,
    id: g.id,
    title: g.title ?? '',
    systems: JSON.parse(JSON.stringify(g.systems)) as Record<string, unknown>,
    actors: Object.fromEntries(Object.entries(g.actors).sort(([a], [b]) => a.localeCompare(b))),
    tags: [...(g.tags ?? [])].sort(),
    sessions: loginChain(g, 'chain').map((id) => {
      const n = byId.get(id);
      return { system: n?.system ?? '', actor: n?.actor ?? '', url: n?.url ?? '' };
    }),
    records: g.nodes.filter((n) => n.type === 'data')
      .map((n) => ({ label: n.label, sobject: n.sobject ?? '' }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    steps: g.edges.filter((e) => e.type === 'does' || e.type === 'denied').map((e) => ({
      from: key(e.from), to: key(e.to), type: e.type,
      catalog: e.data?.catalog ?? '', io: e.data?.io ?? '',
      ioDraft: e.data?.ioDraft === true, capability: e.data?.capability ?? '',
    })),
    expects,
  };
}

// ---------- round trip ----------

for (const file of SHIPPED) {
  test(`round trip: ${path.basename(file)}`, () => {
    const original = load(file);
    const printed = printScript(original);
    const back = parseScript(printed.text);
    expect(back.problems, 'printScript must emit a script parseScript accepts').toEqual([]);
    expect(validateGraph(back.graph)).toEqual({ ok: true, errors: [] });
    expect(view(back.graph)).toEqual(view(original));
  });
}

test('printScript names exactly what it could not express, per shipped graph', () => {
  const dropped = Object.fromEntries(SHIPPED.map((f) => [path.basename(f, '.graph.json'), printScript(load(f)).dropped]));
  expect(dropped).toEqual({
    expense_to_siebel: [
      'edge data.deltaMs: e5',
      'edge label: e2, e3, e5, e7',
      'expectation id: expense_saved, expense_approved',
      'expectation note: expense_saved',
      'node snapshot: sess_siebel_admin',
      'session account (usernameEnv): sess_sf_sales, sess_sf_admin, sess_siebel_admin',
      'session label: sess_sf_sales, sess_sf_admin, sess_siebel_admin',
    ],
    lead_to_customer: [
      'api node: api_create_customer_v2',
      'db node: db_siebel',
      'edge label: e2, e4, e6, e8, e11',
      'expectation (db/log oracle needs an infra node): endpoint_traffic',
      'expectation id: lead_created, lead_potential, credit_approved, customer_created, conversion_toast, customer_visible_in_ui, customer_in_siebel',
      'expectation lastResult: lead_created, lead_potential, credit_approved, customer_created, conversion_toast, customer_visible_in_ui, customer_in_siebel',
      'expectation note: lead_created, lead_potential, credit_approved, customer_created, conversion_toast, customer_visible_in_ui, customer_in_siebel',
      'handoff edge: e_api, e_api2',
      'logger node: log_gateway',
      'node notes: customer_siebel',
      'node snapshot: sess_sf_lead_creator, sess_sf_lead_approver, sess_sf_credit_approver, sess_sf_customer_approver, sess_siebel_admin, chk_customer',
      'node steps (capture state): sess_sf_lead_creator, sess_sf_lead_approver, sess_sf_credit_approver, sess_sf_customer_approver, sess_siebel_admin',
      'node timing: sess_sf_lead_creator, sess_sf_lead_approver, sess_sf_credit_approver, sess_sf_customer_approver, sess_siebel_admin',
      'session account (usernameEnv): sess_sf_lead_creator, sess_sf_lead_approver, sess_sf_credit_approver, sess_sf_customer_approver, sess_siebel_admin',
      'session label: sess_sf_lead_creator, sess_sf_lead_approver, sess_sf_credit_approver, sess_sf_customer_approver',
      'touches edge: e9, e_api3, e_api4',
    ],
    lead_to_customer_via_ado: [
      'edge label: e_do_1, e_do_2, e_do_3, e_do_4, e_do_5',
      'expectation after (edge id rewritten to its catalog): check_lead_record_is_created, check_toast_shows_lead_updat, check_credit_check_screen_sho, check_customer_record_is_crea, check_customer_record_exists',
      'expectation id: check_lead_record_is_created, check_toast_shows_lead_updat, check_credit_check_screen_sho, check_customer_record_is_crea, check_customer_record_exists',
      'expectation note: check_lead_record_is_created, check_toast_shows_lead_updat, check_credit_check_screen_sho, check_customer_record_is_crea, check_customer_record_exists',
    ],
    o2a_tc01_prospect_to_customer: [
      'edge label: e_lead_create, e_lead_convert, e_lead_verify, e_credit_open, e_credit_complete, e_case_create, e_case_close, e_emails, e_credit_approve, e_account_active, e_account_customer',
      'expectation id: lead_created, account_created, record_type_customer, type_prospect, lead_converted, disclosure_visible, accept_visible, mandatory_fields, profile_completed, case_created, case_type, case_subtype, case_routed_to_queue, case_closed, case_origin_email, case_closed_email, owner_notified_email, assessment_approved, status_active, type_customer',
      'expectation note: lead_created, account_created, record_type_customer, type_prospect, lead_converted, disclosure_visible, accept_visible, mandatory_fields, profile_completed, case_created, case_type, case_subtype, case_routed_to_queue, case_closed, case_origin_email, case_closed_email, owner_notified_email, assessment_approved, status_active, type_customer',
      'node notes: sess_sf_client_associate, sess_sf_client_lead, sess_sf_bdm, sess_sf_billing_collections, sess_sf_business_admin, credit_profile, chk_emails',
      'node pos: start, sess_sf_client_associate, sess_sf_client_lead, sess_sf_bdm, sess_sf_billing_collections, sess_sf_business_admin, lead, account, credit_disclosure, credit_profile, case, chk_emails, end',
      'session label: sess_sf_client_associate, sess_sf_client_lead, sess_sf_bdm, sess_sf_billing_collections, sess_sf_business_admin',
    ],
  });
});

// ---------- the two worked examples ----------

// The prototype's paste sheet, verbatim (docs/PROTOTYPE-journey-script-planner.html).
const PROTOTYPE_PASTE = `create_customer  Create a customer
as Client Associate on Salesforce at /lightning/o/Account/list
  create Customer (Account)
    ✓ api.record_exists Account
    ✓ ui.toast was created
  must not delete Customer
as Billing Collections on Salesforce
  verify Customer
    ✓ ui.url /lightning/r/Account/`;

test("the prototype's paste example drafts the graph it promises", () => {
  const { graph, problems } = parseScript(PROTOTYPE_PASTE);
  expect(problems).toEqual([]);
  expect(validateGraph(graph)).toEqual({ ok: true, errors: [] });
  expect(graph.id).toBe('create_customer');
  expect(graph.title).toBe('Create a customer');
  expect(graph.systems).toEqual({ sf: { label: 'Salesforce', kind: 'salesforce' } });
  expect(graph.actors).toEqual({ client_associate: 'client_associate', billing_collections: 'billing_collections' });
  // ONE record shared by both sessions — the same name is the same data node.
  expect(graph.nodes.filter((n) => n.type === 'data').map((n) => [n.id, n.label, n.sobject]))
    .toEqual([['customer', 'Customer', 'Account']]);
  expect(graph.nodes.filter((n) => n.type === 'session').map((n) => n.id))
    .toEqual(['sess_sf_client_associate', 'sess_sf_billing_collections']);
  expect(graph.edges.map((e) => [e.id, e.from, e.to, e.type, e.data?.catalog ?? e.data?.capability ?? ''])).toEqual([
    ['e1', 'start', 'sess_sf_client_associate', 'login_as', ''],
    ['e2', 'sess_sf_client_associate', 'customer', 'does', 'customer.create'],
    ['e3', 'sess_sf_client_associate', 'customer', 'denied', 'customer.delete'],
    ['e4', 'sess_sf_client_associate', 'sess_sf_billing_collections', 'login_as', ''],
    ['e5', 'sess_sf_billing_collections', 'customer', 'does', 'customer.verify'],
    ['e6', 'sess_sf_billing_collections', 'end', 'next', ''],
  ]);
  // No port was stated, so none is invented — inferPorts() drafts them later.
  expect(graph.edges.filter((e) => e.type === 'does').map((e) => e.data?.io)).toEqual([undefined, undefined]);
  expect(graph.nodes.find((n) => n.id === 'customer')?.expects).toEqual([
    { id: 'customer_create_1', kind: 'api.record_exists', target: 'Account', after: 'customer.create' },
    { id: 'customer_create_2', kind: 'ui.toast', value: 'was created', after: 'customer.create' },
    { id: 'customer_verify_1', kind: 'ui.url', value: '/lightning/r/Account/', after: 'customer.verify' },
  ]);
});

// docs/REVIEW-SIMPLIFICATION-2026-09-03.md §5.1's worked example, written in
// the grammar (the review renders it as an outline).
const REVIEW_5_1 = `create_customer  Create a customer

as Client Associate at /lightning/o/Account/list
  create Customer (Account) -> produces
    ✓ api.record_exists Account
    ✓ ui.toast was created
  must not delete Customer

as Billing Collections
  verify Customer -> consumes
`;

test('the review §5.1 example round-trips through print and parse', () => {
  const { graph, problems } = parseScript(REVIEW_5_1);
  expect(problems).toEqual([]);
  expect(validateGraph(graph)).toEqual({ ok: true, errors: [] });
  expect(graph.edges.filter((e) => e.type === 'does').map((e) => e.data?.io)).toEqual(['produces', 'consumes']);
  expect(graph.edges.find((e) => e.type === 'denied')?.data?.capability).toBe('customer.delete');
  const printed = printScript(graph);
  expect(printed.dropped).toEqual([]);
  expect(printed.text).toBe(`create_customer  Create a customer

as client_associate at /lightning/o/Account/list
  create Customer (Account) -> produces
    ✓ api.record_exists Account
    ✓ ui.toast was created
  must not delete Customer

as billing_collections
  verify Customer -> consumes
`);
  expect(view(parseScript(printed.text).graph)).toEqual(view(graph));
});

// ---------- grammar details ----------

test('a draft check and a drafted port survive both directions', () => {
  const { graph, problems } = parseScript([
    'g  T',
    'as user',
    '  create Customer (Account) -> produces?',
    '    ? ui.toast was created',
    '    ✓ api.field_equals Account Status=New within 60000ms every 5000ms',
  ].join('\n'));
  expect(problems).toEqual([]);
  expect(graph.edges.find((e) => e.type === 'does')?.data).toEqual({ catalog: 'customer.create', io: 'produces', ioDraft: true });
  expect(graph.nodes.find((n) => n.id === 'customer')?.expects).toEqual([
    { id: 'customer_create_1', kind: 'ui.toast', value: 'was created', after: 'customer.create', draft: true },
    { id: 'customer_create_2', kind: 'api.field_equals', target: 'Account', value: 'Status=New', after: 'customer.create', timeoutMs: 60_000, pollMs: 5_000 },
  ]);
  expect(printScript(graph).text).toContain('  create Customer (Account) -> produces?');
  expect(printScript(graph).text).toContain('    ? ui.toast was created');
});

test('systems, tags and comments: attributes survive, blank lines and # do not matter', () => {
  const { graph, problems } = parseScript([
    '# a comment',
    'g  T',
    'systems: sf = Salesforce UAT (url:SF_INSTANCE_URL), siebel = Siebel (url:SIEBEL_URL max:1)',
    'tags: smoke, sod',
    '',
    '# another',
    'as admin on siebel via ui',
    '  verify Order record',
  ].join('\n'));
  expect(problems).toEqual([]);
  expect(graph.systems).toEqual({
    sf: { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' },
    siebel: { label: 'Siebel', kind: 'siebel', urlEnv: 'SIEBEL_URL', sessionPolicy: { maxConcurrent: 1 } },
  });
  expect(graph.tags).toEqual(['smoke', 'sod']);
  expect(graph.edges.find((e) => e.type === 'login_as')?.data?.auth).toBe('ui');
  // `verify` onto a name no other line introduces is a CHECKPOINT.
  expect(graph.nodes.find((n) => n.type === 'checkpoint')?.label).toBe('Order record');
});

test('the shorthand systems line the review sketches still parses', () => {
  const { graph, problems } = parseScript('g  T\nsystems: sf=Salesforce siebel=Siebel(max 1)\nas admin on siebel\n  verify Thing (Thing__c)');
  expect(problems).toEqual([]);
  expect(graph.systems).toEqual({
    sf: { label: 'Salesforce', kind: 'salesforce' },
    siebel: { label: 'Siebel', kind: 'siebel', sessionPolicy: { maxConcurrent: 1 } },
  });
});

test('catalogOf is the prototype rule: the record head plus the verb', () => {
  expect(catalogOf('Expense record', 'submit')).toBe('expense.submit');
  expect(catalogOf('Sales Support Case', 'close')).toBe('sales.close');
  expect(catalogOf('Customer', 'Verify')).toBe('customer.verify');
});

// ---------- problems ----------

/** Every parse problem message, for a script that must still come back valid. */
function problemsOf(text: string): string[] {
  const { graph, problems } = parseScript(text);
  expect(validateGraph(graph).ok, `parseScript must always return a valid graph:\n${validateGraph(graph).errors.join('\n')}`).toBe(true);
  return problems.map((p) => `${p.line}: ${p.message}`);
}

test('problem: unknown system key', () => {
  expect(problemsOf('g  T\nsystems: sf = Salesforce\nas admin on crm\n  create Thing'))
    .toEqual(["3: unknown system 'crm' — declared: sf"]);
});

test('problem: a step before any `as` line', () => {
  expect(problemsOf('g  T\n  create Thing\nas admin\n  create Thing'))
    .toEqual(["2: step 'create Thing' comes before any 'as <role>' session line"]);
});

test('problem: a check before any step', () => {
  expect(problemsOf('g  T\nas admin\n  ✓ ui.toast saved\n  create Thing'))
    .toEqual(["3: check 'ui.toast saved' comes before any step line"]);
});

test('problem: malformed within/every timing', () => {
  expect(problemsOf('g  T\nas admin\n  create Thing\n    ✓ api.record_exists Thing__c within 10s'))
    .toEqual(["4: malformed timing — expected 'within <n>ms [every <n>ms]'"]);
});

test('problem: the id is not lower_snake_case', () => {
  expect(problemsOf('Order2Cash  Prospect to customer\nas admin\n  create Thing'))
    .toEqual(["1: id 'Order2Cash' is not lower_snake_case — using 'order2cash'"]);
  expect(parseScript('Order2Cash  T\nas admin\n  create Thing').graph.id).toBe('order2cash');
});

test('problem: the same record is given two SObjects — the first wins', () => {
  expect(problemsOf('g  T\nas admin\n  create Customer (Account)\nas other\n  verify Customer (Contact)'))
    .toEqual(["5: record 'Customer' is already (Account) — ignoring (Contact)"]);
  const { graph } = parseScript('g  T\nas admin\n  create Customer (Account)\nas other\n  verify Customer (Contact)');
  expect(graph.nodes.filter((n) => n.type === 'data').map((n) => n.sobject)).toEqual(['Account']);
});

test('problem: `must not` with no verb', () => {
  expect(problemsOf('g  T\nas admin\n  must not')).toEqual(["3: 'must not' names no verb"]);
});

test('problem: an unknown check kind, and an infra oracle the script cannot declare', () => {
  expect(problemsOf('g  T\nas admin\n  create Thing\n    ✓ ui.sparkle yes\n    ✓ db.query db_x select 1')).toEqual([
    "4: unknown check kind 'ui.sparkle' — one of ui.visible|ui.text|ui.toast|ui.url|api.record_exists|api.field_equals|db.query|log.traffic",
    '5: db.query needs a db/logger node as its target — infra evidence is not expressible in script form',
  ]);
});
