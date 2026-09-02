/**
 * S5 — ado:import: ADO test cases (CSV export with Steps XML, or pasted
 * lines) → draft v2 graphs. Every guess flagged, every oracle draft:true —
 * the human corrects instead of authors; grillme interrogates the flags.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { adoCaseToGraph, parseAdoCsv, parseAdoPaste, parseStepsField, writeAdoGraph } from '../../src/graph/fromAdo';
import { validateGraph } from '../../src/graph/schema';

/** Steps exactly as ADO stores them: XML, HTML-encoded rich text inside. */
const STEPS_XML = `<steps id="0" last="3">
  <step id="1" type="ActionStep">
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;As a lead creator, create a new lead with mandatory fields&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;DIV&gt;Lead record is created and saved&lt;/DIV&gt;</parameterizedString>
  </step>
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">&lt;P&gt;As a lead approver, progress the lead to potential&lt;/P&gt;</parameterizedString>
    <parameterizedString isformatted="true">Toast shows "Lead updated"</parameterizedString>
  </step>
  <step id="3" type="ActionStep">
    <parameterizedString isformatted="true">As a siebel admin, verify the customer in Siebel</parameterizedString>
    <parameterizedString isformatted="true">Customer record exists in Siebel</parameterizedString>
  </step>
</steps>`;

const CSV = [
  'ID,Work Item Type,Title,State,Steps',
  `123,Test Case,Lead to customer happy path,Design,"${STEPS_XML.replace(/"/g, '""')}"`,
  '124,Bug,Not a test case at all,New,',
  '125,Test Case,Empty case no steps,Design,',
].join('\r\n');

test.describe('parsers', () => {
  test('CSV export: quoting survives, non-test-case rows are dropped, Steps XML decodes', () => {
    const cases = parseAdoCsv(CSV);
    expect(cases.map((c) => c.title)).toEqual(['Lead to customer happy path', 'Empty case no steps']);
    const steps = cases[0]!.steps;
    expect(steps).toHaveLength(3);
    expect(steps[0]).toEqual({
      action: 'As a lead creator, create a new lead with mandatory fields',
      expected: 'Lead record is created and saved',
    });
    expect(steps[1]!.expected).toBe('Toast shows "Lead updated"');
  });

  test('pasted text: title line, numbering, and | / -> separators', () => {
    const tc = parseAdoPaste([
      'Title: Quick expense check',
      '1. As a submitter, submit an expense | Expense record is saved',
      '2) approve it -> Status shows Approved',
    ].join('\n'));
    expect(tc.title).toBe('Quick expense check');
    expect(tc.steps).toEqual([
      { action: 'As a submitter, submit an expense', expected: 'Expense record is saved' },
      { action: 'approve it', expected: 'Status shows Approved' },
    ]);
  });

  test('a Steps field that is not XML falls back to plain-line parsing', () => {
    expect(parseStepsField('1. do the thing | it worked')).toEqual([{ action: 'do the thing', expected: 'it worked' }]);
  });
});

test.describe('adoCaseToGraph', () => {
  const graphOf = () => adoCaseToGraph(parseAdoCsv(CSV)[0]!, { knownPersonas: ['lead_creator', 'lead_approver'] });

  test('roles become the session chain; steps become labeled, auto-named does edges', () => {
    const { graph } = graphOf();
    expect(validateGraph(graph).errors).toEqual([]);
    expect(graph.schema).toBe('process-graph/2');
    expect(graph.id).toBe('lead_to_customer_happy_path');

    const sessions = graph.nodes.filter((n) => n.type === 'session').map((n) => n.id);
    expect(sessions).toEqual(['sess_lead_creator', 'sess_lead_approver', 'sess_siebel_admin']);

    const does = graph.edges.filter((e) => e.type === 'does');
    expect(does).toHaveLength(3);
    expect(does[0]!.label).toBe('create a new lead with mandatory fields');
    expect(does.every((e) => e.data?.catalog)).toBe(true); // naming by convention, no meeting

    // The Siebel role provisioned the Siebel system with its single-session policy:
    expect(graph.systems.siebel?.sessionPolicy?.maxConcurrent).toBe(1);
    expect(graph.nodes.find((n) => n.id === 'sess_siebel_admin')?.system).toBe('siebel');
  });

  test('expected results become DRAFT oracles of the right kind', () => {
    const { graph } = graphOf();
    const all = graph.nodes.flatMap((n) => n.expects ?? []);
    expect(all.every((x) => x.draft === true)).toBe(true);
    expect(all.every((x) => x.note?.includes('confirm once'))).toBe(true);

    // 'Lead record is created and saved' → api.record_exists on Lead:
    expect(all.some((x) => x.kind === 'api.record_exists')).toBe(true);
    // 'Toast shows "Lead updated"' → ui.toast with the QUOTED text:
    expect(all.find((x) => x.kind === 'ui.toast')?.value).toBe('Lead updated');
  });

  test('unbound roles and skeleton cases are flagged for grillme, never silent', () => {
    const r = graphOf();
    expect(r.flags.join('\n')).toContain("persona 'siebel_admin' is NOT in personas.json");
    expect(r.flags.join('\n')).not.toContain("persona 'lead_creator'"); // known → no flag

    const empty = adoCaseToGraph({ title: 'Empty case', steps: [] });
    expect(empty.flags.join()).toContain('no steps found');
    expect(validateGraph(empty.graph).errors).toEqual([]);

    const noRole = adoCaseToGraph({ title: 'x', steps: [{ action: 'click the button', expected: 'it clicked' }] });
    expect(noRole.flags.join()).toContain('names no role');
  });
});

test('writeAdoGraph never clobbers an existing graph — drafts get the _ado suffix', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-'));
  const r = adoCaseToGraph(parseAdoPaste('Title: Collide\n1. as a user, do a thing | done'));
  const first = writeAdoGraph(r, tmp);
  expect(path.basename(first.graphFile)).toBe('collide.graph.json');
  const second = writeAdoGraph(r, tmp);
  expect(path.basename(second.graphFile)).toBe('collide_ado.graph.json');
  expect(second.flags.join()).toContain("wrote 'collide_ado'");
  expect(validateGraph(JSON.parse(fs.readFileSync(second.graphFile, 'utf8'))).errors).toEqual([]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Real ADO phrasing (an ADO Test Plans export, 2026-09-02): no "As <role>,"
// prefixes — instead a pre-req step LISTING personas, a "Login … with above
// personas > <first action>" step, mid-case "Login with '<persona>' persona"
// switches, "Verify X is Created." with a trailing period, and expected
// results that say "record" without meaning a record was created.
test.describe('ADO import — real Test Plans phrasing', () => {
  const tc = {
    id: '90001',
    title: 'L2C-TC01_Req 100001: Verify if user has the ability to convert a Prospect',
    steps: [
      { action: 'Pre req : Personas who can perform this action: Client Associate, Client Lead, Business Development Manager' },
      { action: 'Login to Salesforce SIT with above personas >User Convert Lead in Customer hub ( lead conversion process)' },
      { action: 'Create New Account during Lead Conversion.', expected: 'User should be able to create new account during lead conversion' },
      { action: 'Verify Prospect Account is Created.', expected: 'Prospect Account should be created.' },
      { action: 'Verify Record Type is Customer.', expected: 'Record Type should displayed as Customer' },
      { action: 'Navigate to Credit Profile Tab.', expected: 'Credit Profile Tab should be displayed' },
      { action: 'Login with Credit and Collections" persona', expected: 'Logged in successfully' },
      { action: 'Go to same customer > Credit profile', expected: 'Credit Profile screen displayed' },
    ],
  };

  test('pre-req personas open the first session; a mid-case login opens a second; the login-with-above step yields its action', () => {
    const { graph, flags } = adoCaseToGraph(tc, { graphId: 'tc01' });
    expect(validateGraph(graph).ok).toBe(true);
    expect(Object.keys(graph.actors)).toEqual(['client_associate', 'credit_and_collections']);
    const chain = graph.edges.filter((e) => e.type === 'login_as').map((e) => `${e.from}>${e.to}`);
    expect(chain).toEqual(['start>sess_client_associate', 'sess_client_associate>sess_credit_and_collections']);
    const does = graph.edges.filter((e) => e.type === 'does');
    expect(does[0]!.label).toBe('User Convert Lead in Customer hub ( lead conversion process)'); // the part after '>'
    expect(does.filter((e) => e.from === 'sess_client_associate')).toHaveLength(5);
    expect(does.filter((e) => e.from === 'sess_credit_and_collections')).toHaveLength(1);
    expect(flags.join('\n')).toMatch(/pre-req names 3 persona\(s\) .* session bound to 'client_associate'; the rest are alternatives/);
  });

  test('objects survive trailing periods and "is …" phrasing; "record" in an expected result is not a created record', () => {
    const { graph } = adoCaseToGraph(tc, { graphId: 'tc01' });
    const data = graph.nodes.filter((n) => n.type === 'data').map((n) => n.id);
    expect(data).toEqual(['account', 'prospect_account']); // NOT record_type
    const create = graph.edges.find((e) => e.label?.startsWith('Create New Account'))!;
    expect(create.to).toBe('account');
    expect(create.data?.io).toBe('produces');
    const verify = graph.edges.find((e) => e.label === 'Verify Prospect Account is Created.')!;
    expect(verify.to).toBe('prospect_account');
    expect(verify.data?.io).toBe('consumes');
    expect(graph.edges.find((e) => e.label === 'Verify Record Type is Customer.')!.to).toMatch(/^scr_/);
  });

  test('a step ladder (next edges between consecutive step targets) makes the draft read top-to-bottom', () => {
    const { graph } = adoCaseToGraph(tc, { graphId: 'tc01' });
    const does = graph.edges.filter((e) => e.type === 'does');
    const ladder = graph.edges.filter((e) => e.type === 'next' && e.id.startsWith('e_seq_'));
    // one rung between each pair of consecutive targets within a session (chains restart per session)
    expect(ladder.map((e) => `${e.from}>${e.to}`)).toEqual([
      `${does[0]!.to}>${does[1]!.to}`, `${does[1]!.to}>${does[2]!.to}`, `${does[2]!.to}>${does[3]!.to}`, `${does[3]!.to}>${does[4]!.to}`,
    ]);
    expect(validateGraph(graph).ok).toBe(true);
  });
});
