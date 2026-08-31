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
