/**
 * STUDY-DATA-FLOW.md — ports on edges, identity on data nodes. Pins
 * (post-sprint-4.4: no `bind`, no `ref`, `origin` collapsed to `external`):
 *  - schema: the additive fields validate, legacy graphs stay valid;
 *  - dataflowHealth: reaching definitions over the walk (use-before-def,
 *    `external` satisfies, ambient producers, re-produce warning);
 *  - compose: island reports the unproduced consume; splice INFERS `after`;
 *  - toJourneyV2: consumes → {ref:<nodeId>.id}, produces → the node id;
 *  - runner: ctx.produce lands in refs; auto-publish from the landing URL;
 *    a produces step that publishes nothing fails loudly;
 *  - distill: def-use rewrites a created id to {ref:}, external stays literal;
 *  - stitch: cross-recording unification (creator owns the handle);
 *  - fromCapture: ports inferred per group; fromAdo: verb → port; gaps:
 *    `data_port` / `data_unproduced` + their write-back ops.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { normalizeGraph, validateGraph, type ProcessGraph } from '../../src/graph/schema';
import { composeGraphs, dataflowHealth } from '../../src/graph/compose';
import { toJourney } from '../../src/graph/toJourney';
import { runJourney, type CastLike } from '../../src/journeys/runner';
import { StepCatalog } from '../../src/journeys/catalog';
import type { Journey } from '../../src/journeys/schema';
import { distill } from '../../src/pipeline/distill';
import { stitchRecordings } from '../../src/pipeline/stitch';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateArtifacts } from '../../src/pipeline/generate';
import type { RawEvent } from '../../src/pipeline/traceReader';
import { compactFromDistillation } from '../../src/graph/fromCapture';
import { adoCaseToGraph, verbIo } from '../../src/graph/fromAdo';
import { applyAnswers, computeGaps } from '../../src/graph/gaps';
import { goodGraphV2 } from '../helpers/sampleGraph';

const SF = { label: 'Salesforce', kind: 'salesforce' as const };

/** create_customer: admin creates the customer (produces). */
function createCustomer(): ProcessGraph {
  return {
    schema: 'process-graph/2', id: 'create_customer',
    systems: { sf: { ...SF } }, actors: { admin: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_sf_admin', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
      { id: 'customer', type: 'data', label: 'Customer', sobject: 'Account' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'create', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'create customer', data: { catalog: 'cust.create', io: 'produces' } },
      { id: 'e3', from: 'customer', to: 'end', type: 'next' },
    ],
  };
}

/** add_address: a different role opens the customer (consumes) and adds an address. */
function addAddress(): ProcessGraph {
  return {
    schema: 'process-graph/2', id: 'add_address',
    systems: { sf: { ...SF } }, actors: { clerk: 'sales_user' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_sf_clerk', type: 'session', label: 'SF · clerk', system: 'sf', actor: 'clerk' },
      { id: 'customer', type: 'data', label: 'Customer', sobject: 'Account' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 's1', from: 'start', to: 'sess_sf_clerk', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'add', from: 'sess_sf_clerk', to: 'customer', type: 'does', label: 'add address', data: { catalog: 'addr.add', io: 'updates' } },
      { id: 's3', from: 'customer', to: 'end', type: 'next' },
    ],
  };
}

test.describe('schema', () => {
  test('legacy graphs (no ports) stay valid; the new fields validate', () => {
    expect(validateGraph(goodGraphV2()).ok).toBe(true);
    const g = createCustomer();
    expect(validateGraph(g).ok).toBe(true);
    const bad: ProcessGraph = JSON.parse(JSON.stringify(g));
    bad.nodes[1]!.external = true; // a session cannot carry a binding
    bad.nodes[2]!.external = 'yes' as never;
    bad.nodes[2]!.sobject = 'not an api name';
    bad.edges[0]!.data = { auth: 'frontdoor', io: 'consumes' }; // login_as lands on a session
    bad.edges.push({ id: 'z', from: 'sess_sf_admin', to: 'customer', type: 'does', data: { catalog: 'x.y', ioDraft: true } });
    const v = validateGraph(bad);
    expect(v.ok).toBe(false);
    expect(v.errors.join('\n')).toMatch(/nodes.sess_sf_admin.external: only data nodes/);
    expect(v.errors.join('\n')).toMatch(/nodes.customer.external: boolean/);
    expect(v.errors.join('\n')).toMatch(/sobject: SObject API name/);
    expect(v.errors.join('\n')).toMatch(/edges.e1.data.io: a port only makes sense on an edge landing on a data node/);
    expect(v.errors.join('\n')).toMatch(/edges.z.data.ioDraft: needs data.io/);
  });

  test('the node id IS the handle — the retired fields are refused, and normalizeGraph maps them forward', () => {
    const legacy = createCustomer();
    const rec = (v: unknown) => v as Record<string, unknown>;
    rec(legacy.nodes[2]).ref = 'acct';
    rec(legacy.nodes[2]).origin = 'seed';
    rec(legacy.edges[1]!.data).bind = { account: '{ref:acct.id}' };

    const { graph, warnings } = normalizeGraph(legacy);
    expect(validateGraph(graph)).toEqual({ ok: true, errors: [] });
    expect(graph.nodes[2]).toMatchObject({ id: 'customer', external: true });
    expect(graph.nodes[2]).not.toHaveProperty('ref');
    expect(graph.edges[1]!.data).not.toHaveProperty('bind');
    expect(warnings.join('\n')).toMatch(/origin 'seed' → external: true/);
    expect(warnings.join('\n')).toMatch(/ref 'acct' dropped/);
    expect(warnings.join('\n')).toMatch(/data.bind dropped/);

    // 'step' was the default: it just goes, without becoming external.
    const stepped = createCustomer();
    rec(stepped.nodes[2]).origin = 'step';
    const norm = normalizeGraph(stepped);
    expect(norm.graph.nodes[2]).not.toHaveProperty('external');
    expect(norm.warnings.join()).toMatch(/origin 'step' dropped/);
  });
});

test.describe('dataflowHealth — reaching definitions', () => {
  test('a consume with no earlier definition is an error; produces before it clears it', () => {
    const g = addAddress();
    const bad = dataflowHealth(g);
    expect(bad.errors).toHaveLength(1);
    expect(bad.errors[0]).toMatch(/edge add \('add address'\) updates 'Customer' but nothing defines it before this point/);

    const ok = composeGraphs(createCustomer(), addAddress(), { mode: 'splice' }).graph;
    expect(dataflowHealth(ok).errors).toEqual([]);
    expect(dataflowHealth(ok).definedBy.customer).toBe('create');
  });

  test('an external record satisfies a consume; a produces on it warns', () => {
    const g = addAddress();
    g.nodes[2]!.external = true;
    expect(dataflowHealth(g)).toMatchObject({ errors: [], definedBy: { customer: 'external' } });
    g.edges[1]!.data = { catalog: 'addr.add', io: 'produces' };
    expect(dataflowHealth(g).warnings.join()).toMatch(/the node is marked external — who defines it/);
  });

  test('an integration hop (api → data) is an ambient definition; a second produces warns; unused is listed', () => {
    const g = createCustomer();
    g.nodes.push({ id: 'api_repl', type: 'api', label: 'replication' }, { id: 'customer_siebel', type: 'data', label: 'Customer (Siebel)' });
    g.edges.push(
      { id: 'h1', from: 'api_repl', to: 'customer_siebel', type: 'handoff', data: { io: 'produces' } },
      { id: 'again', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'create again', data: { catalog: 'cust.create2', io: 'produces' } },
    );
    const h = dataflowHealth(g);
    expect(h.errors).toEqual([]);
    expect(h.definedBy.customer_siebel).toBe('ambient:h1');
    expect(h.warnings.join()).toMatch(/produces 'Customer' again — already defined by create/);
    expect(h.unused.sort()).toEqual(['customer', 'customer_siebel']);
  });

  test('legacy graphs without ports report clean (nothing to check)', () => {
    const g = goodGraphV2();
    for (const e of g.edges) if (e.data) delete e.data.io;
    expect(dataflowHealth(g)).toEqual({ errors: [], warnings: [], unused: [], definedBy: {} });
  });
});

test.describe('compose', () => {
  test('island: the imported consume is reported unproduced until the human wires it', () => {
    const { graph, summary } = composeGraphs(createCustomer(), addAddress());
    expect(summary.join('\n')).toMatch(/island consumes customer — wire it in AFTER sess_sf_admin \(the session that produces it\)/);
    // …and once wired in after the producer, it is clean.
    graph.edges.push({ id: 'w', from: 'sess_sf_admin', to: 'sess_sf_clerk', type: 'login_as', data: { auth: 'frontdoor' } });
    expect(dataflowHealth(graph).errors).toEqual([]);
    // A host that produces nothing the island needs says so.
    const bare = createCustomer();
    bare.edges[1]!.data = { catalog: 'cust.create' };
    expect(composeGraphs(bare, addAddress()).summary.join('\n')).toMatch(/island consumes customer but nothing in the host produces it/);
  });

  test('splice INFERS the splice point from what the sub consumes (D2)', () => {
    // Host: admin creates the customer, then a reviewer session that produces nothing.
    const h = createCustomer();
    h.actors.reviewer = 'admin2';
    h.nodes.push({ id: 'sess_sf_reviewer', type: 'session', label: 'SF · reviewer', system: 'sf', actor: 'reviewer' });
    h.edges.push(
      { id: 'e4', from: 'sess_sf_admin', to: 'sess_sf_reviewer', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'review', from: 'sess_sf_reviewer', to: 'customer', type: 'does', label: 'review', data: { catalog: 'cust.review', io: 'consumes' } },
    );
    const { graph, summary } = composeGraphs(h, addAddress(), { mode: 'splice' });
    expect(summary.join('\n')).toMatch(/splice point inferred: after sess_sf_admin \(it produces customer/);
    // chain: admin → clerk (inserted right after the producer) → reviewer
    const chain = graph.edges.filter((e) => e.type === 'login_as').map((e) => `${e.from}>${e.to}`);
    expect(chain).toEqual(['start>sess_sf_admin', 'sess_sf_admin>sess_sf_clerk', 'sess_sf_clerk>sess_sf_reviewer']);
    expect(dataflowHealth(graph).errors).toEqual([]);
  });

  test('splice with no data dependency keeps the old default (end of chain)', () => {
    const sub = addAddress();
    sub.edges[1]!.data = { catalog: 'addr.add' }; // no port
    const { summary, graph } = composeGraphs(createCustomer(), sub, { mode: 'splice' });
    expect(summary.join('\n')).not.toMatch(/splice point inferred/);
    expect(graph.edges.some((e) => e.type === 'login_as' && e.from === 'sess_sf_admin' && e.to === 'sess_sf_clerk')).toBe(true);
  });
});

test.describe('toJourneyV2 emission', () => {
  test('produces → the node id to publish; consumes/updates → { record: {ref:<id>.id} }', () => {
    const g = composeGraphs(createCustomer(), addAddress(), { mode: 'splice' }).graph;
    g.nodes.push({ id: 'sess_sf_auditor', type: 'session', label: 'SF · auditor', system: 'sf', actor: 'admin' });
    g.edges.push(
      { id: 'l', from: 'sess_sf_clerk', to: 'sess_sf_auditor', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 'audit', from: 'sess_sf_auditor', to: 'customer', type: 'does', label: 'audit', data: { catalog: 'cust.audit', io: 'consumes' } },
    );
    const r = toJourney(g);
    expect(r.journey.steps).toEqual([
      { actor: 'admin', do: 'cust.create', with: { produce: 'customer', sobject: 'Account' } },
      { actor: 'clerk', do: 'addr.add', with: { record: '{ref:customer.id}' } },
      { actor: 'admin', do: 'cust.audit', with: { record: '{ref:customer.id}' } },
    ]);
  });

  test('a consume of an integration-created record gets the label, not a {ref:} the run could never resolve', () => {
    const g = createCustomer();
    g.nodes.push(
      { id: 'api_repl', type: 'api', label: 'replication' },
      { id: 'customer_siebel', type: 'data', label: 'Customer (Siebel)', sobject: 'Customer' },
    );
    g.edges.push(
      { id: 'h1', from: 'api_repl', to: 'customer_siebel', type: 'handoff', data: { io: 'produces' } },
      { id: 'chk', from: 'sess_sf_admin', to: 'customer_siebel', type: 'does', label: 'check', data: { catalog: 'siebel.check', io: 'consumes' } },
    );
    const r = toJourney(g);
    expect(r.journey.steps[1]).toMatchObject({ with: { record: 'Customer (Siebel)', sobject: 'Customer' } });
    expect(r.warnings.join('\n')).toMatch(/which an integration creates \(h1\) — no id reaches the run/);
  });

  test('use-before-def surfaces as a walker warning (the run would fail on the unknown ref)', () => {
    const r = toJourney(addAddress());
    expect(r.warnings.join('\n')).toMatch(/dataflow: edge add \('add address'\) updates 'Customer' but nothing defines it/);
  });

  test('the data node id is the handle both sides of the port', () => {
    const g = createCustomer();
    g.edges.push({ id: 'open', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'open', data: { catalog: 'cust.open', io: 'consumes' } });
    const r = toJourney(g);
    expect(r.journey.steps[0]).toMatchObject({ with: { produce: 'customer' } });
    expect(r.journey.steps[1]).toMatchObject({ with: { record: '{ref:customer.id}' } });
  });
});

test.describe('runner — produce()', () => {
  const journey: Journey = {
    journey: 'flow', actors: { admin: 'admin', clerk: 'sales_user' },
    steps: [
      { actor: 'admin', do: 'cust.create', with: { produce: 'customer', sobject: 'Account' } },
      { actor: 'clerk', do: 'addr.add', with: { account: '{ref:customer.id}', note: 'for {ref:customer.Name}' } },
    ],
  };
  function cast(url: string): CastLike {
    const page = { url: () => url } as unknown as Page;
    return { async as() { return page; }, async deny() { /* unused */ } };
  }

  test('an explicit produce() lands in refs and the next step resolves it', async () => {
    const seen: unknown[] = [];
    const catalog = new StepCatalog()
      .register('cust.create', async ({ produce, args }) => { produce(String(args.produce), { id: '001AAA000000001AAA', sobject: 'Account', fields: { Name: 'Acme' } }); })
      .register('addr.add', async ({ args }) => { seen.push(args); });
    const report = await runJourney(journey, { cast: cast('about:blank'), catalog });
    expect(report.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(seen).toEqual([{ account: '001AAA000000001AAA', note: 'for Acme' }]);
  });

  test('a produces step that does not publish is auto-published from the record page it landed on', async () => {
    const seen: unknown[] = [];
    const catalog = new StepCatalog()
      .register('cust.create', async () => { /* captured UI step: Lightning redirects to the new record */ })
      .register('addr.add', async ({ args }) => { seen.push(args.account); });
    const idOnly: Journey = { ...journey, steps: [journey.steps[0]!, { actor: 'clerk', do: 'addr.add', with: { account: '{ref:customer.id}' } }] };
    await runJourney(idOnly, { cast: cast('https://x.my.salesforce.com/lightning/r/Account/001BBB000000002BBB/view'), catalog });
    expect(seen).toEqual(['001BBB000000002BBB']);
  });

  test('publishing nothing, or the wrong object, fails loudly — never a silent wrong record', async () => {
    const catalog = new StepCatalog().register('cust.create', async () => {}).register('addr.add', async () => {});
    await expect(runJourney(journey, { cast: cast('https://x.my.salesforce.com/lightning/o/Account/list'), catalog }))
      .rejects.toThrow(/produces 'customer' but published nothing/);
    await expect(runJourney(journey, { cast: cast('https://x.my.salesforce.com/lightning/r/Contact/003CCC000000003CCC/view'), catalog }))
      .rejects.toThrow(/\(Account\) but landed on a Contact record — wrong object/);
  });
});

test.describe('capture — def-use over the recording', () => {
  const click = (selector: string, startMs: number, endMs: number): RawEvent => ({ kind: 'action', api: 'click', selector, startMs, endMs });
  const fill = (selector: string, value: string, startMs: number, endMs: number): RawEvent => ({ kind: 'action', api: 'fill', selector, value, startMs, endMs });
  const nav = (url: string, startMs: number, endMs: number): RawEvent => ({ kind: 'nav', url, startMs, endMs });
  const ID = '001xx000003DGbYAAW';

  test('the save defines the record; the redirect becomes recordPage.landed; later uses become {ref:}', () => {
    const d = distill([
      nav('https://x.my.salesforce.com/lightning/o/Account/new', 0, 50),
      fill('internal:label="Account Name"i', 'Acme', 100, 120),
      click('internal:role=button[name="Save"i]', 200, 230),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 300, 400), // Lightning redirect
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 900, 950), // human re-opens it
    ]);
    expect(d.steps.map((s) => s.catalog)).toEqual(['nav.goto', 'form.fill', 'modal.save', 'recordPage.landed', 'recordPage.open']);
    expect(d.steps[3]!.args).toEqual({ sobject: 'Account', produce: 'account' });
    expect(d.steps[4]!.args).toEqual({ sobject: 'Account', id: '{ref:account.id}' });
    expect(d.harvestedIds[0]).toMatchObject({ id: ID, handle: 'account', origin: 'step', defStep: 2, useSteps: [3, 4] });
    expect(d.flags.join('\n')).toMatch(/Account 001xx000003DGbYAAW is CREATED by step 2 \(modal.save\) → handle 'account'/);
    expect(JSON.stringify(d.steps)).not.toContain(ID);
  });

  test('the generated module publishes on recordPage.landed', () => {
    const d = distill([
      click('internal:role=button[name="Save"i]', 200, 230),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 300, 400),
    ]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dataflow-gen-'));
    const outDirs = { journeys: path.join(root, 'j'), stubs: path.join(root, 's'), baselines: path.join(root, 'b'), encoding: path.join(root, 'e') };
    const out = generateArtifacts(d, { journeyId: 'j', persona: 'admin', personaIds: ['admin'], outDirs, today: '2026-09-02' });
    const source = fs.readFileSync(out.stubsFile, 'utf8');
    expect(source).toContain(".register('recordPage.landed', async ({ page, args, produce }) =>");
    expect(source).toContain('produce(String(args.produce), { id, sobject: String(args.sobject) })');
    expect(out.journey.steps[1]).toMatchObject({ do: 'recordPage.landed', with: { sobject: 'Account', produce: 'account' } });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('two records of one object get numbered handles; a record nobody created stays literal (external)', () => {
    const ID2 = '001xx000003DGbZAAW';
    const d = distill([
      click('internal:role=button[name="Save"i]', 0, 10),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 20, 30),
      click('internal:role=button[name="Save"i]', 100, 110),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID2}/view`, 120, 130),
      nav('https://x.my.salesforce.com/lightning/r/Contact/003xx000004TmiQAAS/view', 200, 210),
    ]);
    expect(d.harvestedIds.map((h) => [h.handle, h.origin])).toEqual([['account', 'step'], ['account_2', 'step'], ['contact', 'external']]);
    expect(d.steps[4]!.args).toEqual({ sobject: 'Contact', id: '003xx000004TmiQAAS' });
    expect(d.flags.join('\n')).toMatch(/record 003xx000004TmiQAAS \(Contact\) pre-existed/);
  });

  test('stitch unifies across recordings: the creator owns the handle, the other actor resolves it', () => {
    const creator = distill([
      click('internal:role=button[name="Save"i]', 0, 10),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 20, 30),
    ]);
    const approver = distill([
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 0, 10),
      click('internal:role=button[name="Approve"i]', 20, 30),
    ]);
    expect(approver.steps[0]!.args.id).toBe(ID); // alone, it looked external
    const st = stitchRecordings([
      { alias: 'creator', persona: 'admin', distillation: creator, wallOffsetMs: 1000 },
      { alias: 'approver', persona: 'admin2', distillation: approver, wallOffsetMs: 5000 },
    ]);
    const approverOpen = st.distillation.steps.find((s) => s.actorAlias === 'approver' && s.catalog === 'recordPage.open')!;
    expect(approverOpen.args).toEqual({ sobject: 'Account', id: '{ref:account.id}' });
    expect(st.distillation.harvestedIds).toHaveLength(1);
    expect(st.distillation.harvestedIds[0]).toMatchObject({ id: ID, handle: 'account', origin: 'step', defStep: 0, useSteps: [1, 2] });
    expect(st.distillation.flags.join('\n')).toMatch(/created by creator; every actor now resolves it as \{ref:account.id\}/);
  });

  test('stitch numbers a handle that would name two different records', () => {
    const ID2 = '001xx000003DGbZAAW';
    const a = distill([click('internal:role=button[name="Save"i]', 0, 10), nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 20, 30)]);
    const b = distill([click('internal:role=button[name="Save"i]', 0, 10), nav(`https://x.my.salesforce.com/lightning/r/Account/${ID2}/view`, 20, 30)]);
    const st = stitchRecordings([
      { alias: 'one', persona: 'p1', distillation: a, wallOffsetMs: 0 },
      { alias: 'two', persona: 'p2', distillation: b, wallOffsetMs: 100 },
    ]);
    expect(st.distillation.harvestedIds.map((h) => h.handle).sort()).toEqual(['account', 'account_2']);
    const landedTwo = st.distillation.steps.find((s) => s.actorAlias === 'two' && s.catalog === 'recordPage.landed')!;
    expect(landedTwo.args.produce).toBe('account_2');
  });

  test('capture-first graph: the creating group PRODUCES, the approver CONSUMES, the data node carries the SObject', () => {
    const creator = distill([
      fill('internal:label="Account Name"i', 'Acme', 0, 10),
      click('internal:role=button[name="Save"i]', 20, 30),
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 40, 50),
    ]);
    const approver = distill([
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 0, 10),
      click('internal:role=button[name="Approve"i]', 20, 30),
    ]);
    const st = stitchRecordings([
      { alias: 'creator', persona: 'admin', distillation: creator, wallOffsetMs: 0 },
      { alias: 'approver', persona: 'admin2', distillation: approver, wallOffsetMs: 1000 },
    ]);
    const { graph } = compactFromDistillation(st.distillation, {
      graphId: 'acct', journeyId: 'acct', actors: st.actors, systems: { sf: { ...SF } },
    });
    expect(validateGraph(graph).ok).toBe(true);
    const account = graph.nodes.find((n) => n.type === 'data')!;
    expect(account).toMatchObject({ id: 'account', sobject: 'Account' });
    const ports = graph.edges.filter((e) => e.type === 'does').map((e) => [e.from, e.data?.io]);
    expect(ports).toEqual([['sess_creator', 'produces'], ['sess_approver', 'consumes']]);
    expect(dataflowHealth(graph).errors).toEqual([]);
    expect(toJourney(graph).journey.steps.map((s) => ('with' in s ? s.with : s))).toEqual([
      { produce: 'account', sobject: 'Account' },
      { record: '{ref:account.id}' },
    ]);
  });

  test('capture-first graph: a record nobody created is marked external', () => {
    const d = distill([
      nav(`https://x.my.salesforce.com/lightning/r/Account/${ID}/view`, 0, 10),
      click('internal:role=button[name="Edit"i]', 20, 30),
      click('internal:role=button[name="Save"i]', 40, 50),
    ]);
    const { graph, flags } = compactFromDistillation(d, { graphId: 'g', journeyId: 'g', actors: { main: 'admin' } });
    expect(graph.nodes.find((n) => n.type === 'data')).toMatchObject({ id: 'account', external: true });
    expect(graph.edges.find((e) => e.type === 'does')?.data?.io).toBe('updates');
    expect(flags.join('\n')).toMatch(/Account record pre-existed in the capture/);
    expect(dataflowHealth(graph).errors).toEqual([]);
  });
});

test.describe('ADO import — verb → port', () => {
  test('verbIo', () => {
    expect(verbIo('Create a new lead')).toBe('produces');
    expect(verbIo('Approve the lead')).toBe('updates');
    expect(verbIo('Add a new address to existing customer')).toBe('produces');
    expect(verbIo('Add the contact to the account')).toBe('updates');
    expect(verbIo('Open the customer record')).toBe('consumes');
    expect(verbIo('Verify customer exists')).toBe('consumes');
  });

  test('a step on a known object lands on its data node with a DRAFT port; the create graph flows', () => {
    const { graph, flags } = adoCaseToGraph({
      title: 'Customer with address',
      steps: [
        { action: 'Create a new customer', expected: 'Customer record is created' },
        { action: 'Add a new address to existing customer', expected: 'Address saved' },
        { action: 'Open the customer', expected: 'Address is shown' },
      ],
    }, { graphId: 'cust_addr' });
    expect(validateGraph(graph).ok).toBe(true);
    // 'add … address' names the ADDRESS as its object (draft — grillme can re-aim it).
    const ports = graph.edges.filter((e) => e.type === 'does').map((e) => [e.to, e.data?.io, e.data?.ioDraft]);
    expect(ports).toEqual([['customer', 'produces', true], ['address', 'produces', true], ['customer', 'consumes', true]]);
    expect(graph.nodes.find((n) => n.id === 'customer')).toMatchObject({ type: 'data', sobject: 'Customer' });
    expect(flags.join('\n')).toMatch(/'Create a new customer' produces the Customer record/);
    expect(dataflowHealth(graph).errors).toEqual([]);
  });
});

test.describe('grillme — data gaps and write-back', () => {
  test('draft ports, missing ports, and unproduced consumes are questions; the ops answer them', () => {
    const g = addAddress();
    g.edges[1]!.data = { catalog: 'addr.add', io: 'updates', ioDraft: true };
    g.edges.push({ id: 'noport', from: 'sess_sf_clerk', to: 'customer', type: 'does', label: 'look', data: { catalog: 'cust.look' } });
    const { gaps } = computeGaps(g);
    const kinds = gaps.map((x) => `${x.kind}@${x.at}`);
    expect(kinds).toContain('data_port@add');     // a guess, with a default
    expect(kinds).toContain('data_port@noport');  // no port at all
    expect(kinds).toContain('data_unproduced@add');
    expect(gaps.find((x) => x.at === 'add' && x.kind === 'data_port')?.options)
      .toEqual(['keep: updates', 'change to: produces', 'change to: consumes']);
    expect(gaps.find((x) => x.kind === 'data_unproduced')?.question).toMatch(/Where does the Customer come from\?/);

    const { graph, changes } = applyAnswers(g, [
      { op: 'setIo', edge: 'add' },                      // no io = confirm the guess
      { op: 'setIo', edge: 'noport', io: 'consumes' },
      { op: 'setExternal', node: 'customer', external: true },
    ]);
    expect(changes).toEqual(['add io updates confirmed', 'noport io = consumes', 'customer external = true']);
    expect(graph.edges[1]!.data?.ioDraft).toBeUndefined();
    expect(computeGaps(graph).gaps.filter((x) => x.kind.startsWith('data_'))).toEqual([]);
    expect(() => applyAnswers(g, [{ op: 'setExternal', node: 'sess_sf_clerk', external: true }])).toThrow(/not a data node/);
    expect(() => applyAnswers(g, [{ op: 'setIo', edge: 'noport' }])).toThrow(/has no port to confirm/);
  });
});
