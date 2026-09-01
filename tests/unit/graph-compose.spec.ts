/**
 * Graph composition — import add_address INTO create_customer and the walk
 * covers more functionality. Pins the seam semantics: session merge on
 * system+actor+account, chain splice (with return edge + auth carried),
 * node merge on id+type with check union, prefixing on true collisions,
 * after-remap, provenance, and loud refusals for actor/system disagreements.
 */
import { test, expect } from '@playwright/test';
import { chainHealth, composeGraphs } from '../../src/graph/compose';
import { toJourney } from '../../src/graph/toJourney';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';

const SF = { label: 'Salesforce UAT', kind: 'salesforce' as const, urlEnv: 'SF_INSTANCE_URL' };

function host(): ProcessGraph {
  return {
    schema: 'process-graph/2', id: 'create_customer', title: 'Create customer',
    systems: { sf: { ...SF } },
    actors: { admin: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_sf_admin', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
      { id: 'customer', type: 'data', label: 'Customer', expects: [{ id: 'customer_created', kind: 'api.record_exists', target: 'Account', after: 'cust.create' }] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'act', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'create customer', data: { catalog: 'cust.create' } },
      { id: 'e3', from: 'customer', to: 'end', type: 'next' },
    ],
  };
}

function addAddress(): ProcessGraph {
  return {
    schema: 'process-graph/2', id: 'add_address', title: 'Add address',
    systems: { sf: { ...SF } },
    actors: { admin: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_sf_admin', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
      { id: 'address', type: 'data', label: 'Address', expects: [{ id: 'address_saved', kind: 'ui.toast', value: 'saved', after: 'addr.add' }] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 's1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'act', from: 'sess_sf_admin', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } },
      { id: 's3', from: 'address', to: 'end', type: 'next' },
    ],
  };
}

test('SPLICE mode — add_address extends create_customer: session merges, steps append, the walk covers both', () => {
  const r = composeGraphs(host(), addAddress(), { ref: 'sf_core/add_address', now: '2026-09-01T00:00:00.000Z', mode: 'splice' });

  expect(validateGraph(r.graph).ok).toBe(true);
  // One session (merged), the address node imported, ends deduped.
  expect(r.graph.nodes.filter((n) => n.type === 'session').length).toBe(1);
  expect(r.graph.nodes.find((n) => n.id === 'address')).toBeTruthy();
  expect(r.graph.nodes.filter((n) => n.type === 'end').length).toBe(1);
  expect(r.summary.join()).toContain('merged into sess_sf_admin');

  // The composed WALK is the point: create, then add address.
  const walk = toJourney(r.graph, { personaIds: ['admin'] });
  expect(walk.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['cust.create', 'addr.add']);

  // Provenance recorded.
  expect(r.graph.composedFrom).toEqual([{ ref: 'sf_core/add_address', graphId: 'add_address', at: '2026-09-01T00:00:00.000Z' }]);
});

test('ISLAND is the default — the sub arrives intact but unwired; the human connects it', () => {
  const r = composeGraphs(host(), addAddress(), { ref: 'add_address', now: '2026-09-01T00:00:00.000Z' });

  // No session merge — the sub's admin session lands beside the host's.
  expect(r.graph.nodes.filter((n) => n.type === 'session').length).toBe(2);
  const arrival = r.graph.nodes.find((n) => n.id === 'add_address_sess_sf_admin');
  expect(arrival?.type).toBe('session');

  // Nothing wired: the walk still covers ONLY the host…
  const walk = toJourney(r.graph, { personaIds: ['admin'] });
  expect(walk.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['cust.create']);
  // …and chain health names the stranded arrival until the human wires it.
  expect(chainHealth(r.graph).stranded).toEqual(['add_address_sess_sf_admin']);

  // The sub's end-pointing edge is dropped, with the relink note.
  expect(r.graph.edges.find((e) => e.id === 's3' || e.id === 'add_address_s3')).toBeUndefined();
  expect(r.summary.join()).toContain('relink to end once the island is wired in');
  expect(r.summary.join()).toContain('UNWIRED');
  expect(r.graph.composedFrom?.[0]).toMatchObject({ graphId: 'add_address' });
  expect(validateGraph(r.graph).ok).toBe(true);
});

test('island keeps the sub\'s INTERNAL chain — wiring in is ONE login_as edge, then relink end', () => {
  // Sub with two chained sessions of its own.
  const sub = addAddress();
  sub.actors = { clerk: 'lead_creator', checker: 'sales_user' };
  sub.nodes[1] = { id: 'sess_clerk', type: 'session', label: 'clerk', system: 'sf', actor: 'clerk' };
  sub.nodes.splice(2, 0, { id: 'sess_checker', type: 'session', label: 'checker', system: 'sf', actor: 'checker' });
  sub.edges = [
    { id: 's1', from: 'start', to: 'sess_clerk', type: 'login_as', data: { auth: 'ui' } },
    { id: 's_mid', from: 'sess_clerk', to: 'sess_checker', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 's2', from: 'sess_clerk', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } },
    { id: 's2b', from: 'sess_checker', to: 'address', type: 'does', label: 'verify address', data: { catalog: 'addr.verify' } },
    { id: 's3', from: 'address', to: 'end', type: 'next' },
  ];

  const r = composeGraphs(host(), sub);
  // Internal chain edge survives the import…
  const internal = r.graph.edges.find((e) => e.type === 'login_as' && e.from === 'sess_clerk' && e.to === 'sess_checker');
  expect(internal?.data?.auth).toBe('frontdoor');

  // …so the HUMAN completes the wiring with one edge + an end relink:
  r.graph.edges.push({ id: 'hand_wired', from: 'sess_sf_admin', to: 'sess_clerk', type: 'login_as', data: { auth: 'ui' } });
  r.graph.edges.push({ id: 'hand_end', from: 'address', to: 'end', type: 'next' });
  const walk = toJourney(r.graph, { personaIds: ['admin', 'lead_creator', 'sales_user'] });
  expect(walk.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['cust.create', 'addr.add', 'addr.verify']);
});

test('colliding edge ids get the sub prefix, and imported checks follow their renamed after-edge', () => {
  const sub = addAddress();
  sub.nodes[2]!.expects = [{ id: 'address_saved', kind: 'ui.toast', value: 'saved', after: 'act' }]; // after = EDGE id this time
  const r = composeGraphs(host(), sub);
  const renamed = r.graph.edges.find((e) => e.id === 'add_address_act');
  expect(renamed).toBeTruthy(); // sub's 'act' collided with the host's
  const address = r.graph.nodes.find((n) => n.id === 'address');
  expect(address?.expects?.[0]?.after).toBe('add_address_act');
});

test('a different actor splices into the chain with auth carried, and returns to the old next hop', () => {
  const h = host();
  // Host chain: admin → approver.
  h.actors.approver = 'sales_user';
  h.nodes.splice(2, 0, { id: 'sess_sf_approver', type: 'session', label: 'SF · approver', system: 'sf', actor: 'approver' });
  h.edges.push({ id: 'e_l2', from: 'sess_sf_admin', to: 'sess_sf_approver', type: 'login_as', data: { auth: 'frontdoor' } });
  h.edges.push({ id: 'e_appr', from: 'sess_sf_approver', to: 'customer', type: 'does', label: 'approve', data: { catalog: 'cust.approve' } });

  const sub = addAddress();
  sub.actors = { address_clerk: 'lead_creator' };
  sub.nodes[1] = { id: 'sess_sf_clerk', type: 'session', label: 'SF · clerk', system: 'sf', actor: 'address_clerk' };
  sub.edges[0] = { id: 's1', from: 'start', to: 'sess_sf_clerk', type: 'login_as', data: { auth: 'ui' } };
  sub.edges[1] = { id: 'act', from: 'sess_sf_clerk', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } };

  const r = composeGraphs(h, sub, { after: 'sess_sf_admin' });
  // admin → clerk (auth from the sub's own login edge) → back to approver (original auth).
  const intoClerk = r.graph.edges.find((e) => e.type === 'login_as' && e.to === 'sess_sf_clerk');
  expect(intoClerk?.from).toBe('sess_sf_admin');
  expect(intoClerk?.data?.auth).toBe('ui');
  const returnEdge = r.graph.edges.find((e) => e.type === 'login_as' && e.from === 'sess_sf_clerk');
  expect(returnEdge?.to).toBe('sess_sf_approver');
  expect(returnEdge?.data?.auth).toBe('frontdoor');

  const walk = toJourney(r.graph, { personaIds: ['admin', 'sales_user', 'lead_creator'] });
  expect(walk.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['cust.create', 'addr.add', 'cust.approve']);
});

test('same-id data nodes merge and union their checks; identical duplicates collapse', () => {
  const sub = addAddress();
  sub.nodes[2] = {
    id: 'customer', type: 'data', label: 'Customer',
    expects: [
      { id: 'customer_created', kind: 'api.record_exists', target: 'Account', after: 'cust.create' }, // identical → dropped
      { id: 'billing_set', kind: 'api.field_equals', target: 'Account', value: 'BillingCity=Auckland', after: 'addr.add' },
    ],
  };
  sub.edges[1] = { id: 's2', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'add address', data: { catalog: 'addr.add' } };
  sub.edges[2] = { id: 's3', from: 'customer', to: 'end', type: 'next' };

  const r = composeGraphs(host(), sub);
  const customer = r.graph.nodes.find((n) => n.id === 'customer');
  expect(customer?.expects?.map((x) => x.id).sort()).toEqual(['billing_set', 'customer_created']);
  expect(r.summary.join()).toContain('checks unioned');
});

test('same id but a different TYPE imports under the sub prefix instead of merging', () => {
  const sub = addAddress();
  sub.nodes[2] = { id: 'customer', type: 'screen', label: 'Customer screen' };
  sub.edges[1] = { id: 's2', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'open customer', data: { catalog: 'cust.open' } };
  sub.edges[2] = { id: 's3', from: 'customer', to: 'end', type: 'next' };
  const r = composeGraphs(host(), sub);
  expect(r.graph.nodes.find((n) => n.id === 'add_address_customer')?.type).toBe('screen');
  expect(r.graph.nodes.find((n) => n.id === 'customer')?.type).toBe('data'); // host untouched
});

test("splicing the same sub twice appends the flow twice — dedup is the author's call", () => {
  const once = composeGraphs(host(), addAddress(), { mode: 'splice' }).graph;
  const twice = composeGraphs(once, addAddress(), { mode: 'splice' }).graph;
  const walk = toJourney(twice, { personaIds: ['admin'] });
  expect(walk.journey.steps.map((s) => (s as { do?: string }).do)).toEqual(['cust.create', 'addr.add', 'addr.add']);
  expect(twice.composedFrom?.length).toBe(2);
});

test('loud refusals: actor disagreement, system disagreement, self-import, bad splice point', () => {
  const subActor = addAddress();
  subActor.actors.admin = 'sales_user';
  expect(() => composeGraphs(host(), subActor)).toThrow(/alias 'admin' means 'admin' here but 'sales_user'/);

  const subSys = addAddress();
  subSys.systems.sf = { ...SF, urlEnv: 'OTHER_ORG_URL' };
  expect(() => composeGraphs(host(), subSys)).toThrow(/system 'sf' is defined differently/);

  const self = host();
  expect(() => composeGraphs(host(), self)).toThrow(/into itself/);

  const subSplice = addAddress();
  subSplice.actors = { clerk: 'lead_creator' };
  subSplice.nodes[1] = { id: 'sess_c', type: 'session', label: 'c', system: 'sf', actor: 'clerk' };
  subSplice.edges[0] = { id: 's1', from: 'start', to: 'sess_c', type: 'login_as' };
  subSplice.edges[1] = { id: 'act2', from: 'sess_c', to: 'address', type: 'does', label: 'x', data: { catalog: 'addr.add' } };
  expect(() => composeGraphs(host(), subSplice, { after: 'ghost' })).toThrow(/not a session in the host chain/);
});
