/**
 * Cross-case linkage for ado:import (owner, 2026-09-04: "sequential cases
 * are interpreted as isolated journeys — link them from the language"). Pins:
 *  - profileCase: creates/uses/unbound read from actions AND expected results,
 *    "verify X is created" counts as a create, "existing X" is not a hand-off;
 *  - linkCases: nearest-earlier producer links (dataflow), a later-only
 *    producer is weak, explicit ADO id / "previous test case" is stated,
 *    no producer → pre-existing flag; chains in run order;
 *  - the Step Expected cell survives verbatim as the expectation note;
 *  - the manifest persists profiles + links and apply flags carry them.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describeChains, linkCases, objectKey, profileCase } from '../../src/graph/adoLinkage';
import { applyImport, storeImport } from '../../src/graph/adoImports';
import { adoCaseToGraph, type AdoCase } from '../../src/graph/fromAdo';

const CREATE_LEAD: AdoCase = {
  id: '101', title: 'Create a lead',
  steps: [
    { action: 'As a sales user, create a new lead', expected: 'Lead record is created and a toast "Lead created" shows' },
  ],
};
const CONVERT_LEAD: AdoCase = {
  id: '102', title: 'Convert the lead',
  steps: [
    { action: 'As a sales user, open the lead', expected: 'Lead detail page loads' },
    { action: 'Convert the lead', expected: 'Account and Contact are created' },
  ],
};
const VERIFY_ACCOUNT: AdoCase = {
  id: '103', title: 'Check the account',
  steps: [{ action: 'As a sales manager, open the account', expected: 'Account is visible' }],
};
const STANDALONE: AdoCase = {
  id: '104', title: 'Update an existing case',
  steps: [{ action: 'As a service agent, update the existing case record', expected: 'Case is saved' }],
};

test.describe('objectKey', () => {
  test('lower_snake and singular', () => {
    expect(objectKey('Leads')).toBe('lead');
    expect(objectKey('Prospect Accounts')).toBe('prospect_account');
    expect(objectKey('Opportunities')).toBe('opportunity');
    expect(objectKey('Address')).toBe('address');
    expect(objectKey('Status')).toBe('status');
  });
});

test.describe('profileCase', () => {
  test('creates and uses read from the action verbs', () => {
    const p = profileCase(CONVERT_LEAD, 1);
    expect(p.consumes).toEqual(['lead']);
    expect(p.unbound).toEqual(['lead']);
    expect(p.produces).toEqual(expect.arrayContaining(['account', 'contact']));
  });

  test('the expected result names what got created', () => {
    const p = profileCase(CREATE_LEAD, 0);
    expect(p.produces).toEqual(['lead']);
    expect(p.unbound).toEqual([]);
  });

  test('"verify X is created" is a create, not a hand-off', () => {
    const p = profileCase({ title: 't', steps: [
      { action: 'Convert the lead', expected: 'Conversion completes' },
      { action: 'Verify Prospect Account is Created.', expected: 'Prospect Account is created' },
    ] }, 0);
    expect(p.produces).toContain('prospect_account');
    expect(p.unbound).toEqual(['lead']);
  });

  test('"existing X" is external, not unbound', () => {
    const p = profileCase(STANDALONE, 3);
    expect(p.existing).toEqual(['case']);
    expect(p.consumes).toEqual(['case']);
    expect(p.unbound).toEqual([]);
  });

  test('mentions: ADO ids and "previous test case"', () => {
    const p = profileCase({ id: '200', title: 't', steps: [
      { action: 'Using the lead from TC 101, open it' },
      { action: 'Approve the quote created in the previous test case' },
      { action: 'See #200 for context' }, // its own id is not a mention
    ] }, 0);
    expect(p.mentions).toEqual({ ids: ['101'], previous: true });
  });
});

test.describe('linkCases', () => {
  test('nearest earlier producer links the cases; chains read in run order', () => {
    const r = linkCases([CREATE_LEAD, CONVERT_LEAD, VERIFY_ACCOUNT, STANDALONE]);
    expect(r.links).toEqual([
      expect.objectContaining({ from: 0, to: 1, objects: ['lead'], confidence: 'dataflow' }),
      expect.objectContaining({ from: 1, to: 2, objects: ['account'], confidence: 'dataflow' }),
    ]);
    expect(r.chains).toEqual([[0, 1, 2]]);
    expect(describeChains(r)).toEqual(['#0 → #1 → #2  (lead, account)']);
    expect(r.flags[1]?.[0]).toMatch(/continuation of #0 \(101\) 'Create a lead'/);
    expect(r.flags[3] ?? []).toEqual([]); // 'existing case' — nothing to say
    // The last case of a journey: one continuation flag, no dangling-create note.
    expect(r.flags[2]).toEqual([expect.stringMatching(/^consumes 'account'.*continuation of #1 \(102\) 'Convert the lead', which creates it$/)]);
  });

  test('a producer that only comes later is a weak link and says the order may be wrong', () => {
    const r = linkCases([CONVERT_LEAD, CREATE_LEAD]);
    expect(r.links).toEqual([expect.objectContaining({ from: 1, to: 0, objects: ['lead'], confidence: 'weak' })]);
    expect(r.chains).toEqual([[1, 0]]);
    expect(describeChains(r)[0]).toContain('⚠ order uncertain');
    expect(r.flags[0]?.[0]).toMatch(/comes LATER in the sheet/);
  });

  test('no producer anywhere → pre-existing data flag, no link', () => {
    const r = linkCases([CONVERT_LEAD]);
    expect(r.links).toEqual([]);
    expect(r.chains).toEqual([]);
    expect(r.flags[0]?.[0]).toMatch(/no case in this import creates it; pre-existing data \(mark the data node external: true\)/);
  });

  test('stated references outrank dataflow and reach cases with no data overlap', () => {
    const r = linkCases([
      CREATE_LEAD,
      { id: '150', title: 'Report', steps: [{ action: 'Run the report described in test case 101' }] },
    ]);
    expect(r.links).toEqual([expect.objectContaining({ from: 0, to: 1, objects: [], confidence: 'stated' })]);
    expect(r.flags[1]?.[0]).toMatch(/its steps name test case 101/);
  });

  test('a create nobody uses is noted as the end of a journey', () => {
    const r = linkCases([CREATE_LEAD, STANDALONE]);
    expect(r.flags[0]?.[0]).toMatch(/creates 'lead' that no other case uses/);
  });
});

test.describe('Step Expected on the graph', () => {
  test('the expected cell lands verbatim as the expectation note, after the step edge', () => {
    const { graph } = adoCaseToGraph(CREATE_LEAD);
    const lead = graph.nodes.find((n) => n.type === 'data')!;
    expect(lead.expects).toHaveLength(1);
    const x = lead.expects![0]!;
    expect(x.after).toBe('e_do_1');
    expect(x.draft).toBe(true);
    expect(x.note).toBe('Lead record is created and a toast "Lead created" shows');
    expect(x.kind).toBe('ui.toast');
    expect(x.value).toBe('Lead created');
  });
});

test.describe('import manifest + apply flags', () => {
  function rowsCsv(cases: AdoCase[]): string {
    const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
    const lines = ['ID,Work Item Type,Title,Test Step,Step Action,Step Expected'];
    for (const c of cases) {
      c.steps.forEach((s, i) => {
        lines.push([i === 0 ? c.id ?? '' : '', i === 0 ? 'Test Case' : '', i === 0 ? c.title : '', String(i + 1), s.action, s.expected ?? ''].map(q).join(','));
      });
    }
    return lines.join('\n') + '\n';
  }

  test('storeImport persists produces/consumes/unbound, links and chains; applyImport flags the continuation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpw-linkage-'));
    fs.mkdirSync(path.join(root, 'projects', 'sf'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'sf', 'project.json'), '{}');
    const stored = storeImport(root, 'sf', 'plan.csv', Buffer.from(rowsCsv([CREATE_LEAD, CONVERT_LEAD, STANDALONE])));
    expect(stored.manifest.cases[0]).toMatchObject({ id: '101', produces: ['lead'] });
    expect(stored.manifest.cases[1]).toMatchObject({ id: '102', consumes: ['lead'], unbound: ['lead'] });
    expect(stored.manifest.cases[2]?.unbound).toBeUndefined();
    expect(stored.manifest.links).toEqual([expect.objectContaining({ from: 0, to: 1, objects: ['lead'] })]);
    expect(stored.manifest.chains).toEqual([[0, 1]]);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'projects', 'sf', 'imports', `${stored.manifest.id}.json`), 'utf8'));
    expect(onDisk.chains).toEqual([[0, 1]]);

    // Import ONLY the second case: the flag still names the first (skipped) one.
    const applied = applyImport(root, 'sf', stored.manifest.id, [1]);
    expect(applied.results).toHaveLength(1);
    expect(applied.results[0]!.flags).toEqual(expect.arrayContaining([expect.stringMatching(/^sequence: .*continuation of #0 \(101\) 'Create a lead'/)]));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a single-case import has no links block', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpw-linkage-'));
    fs.mkdirSync(path.join(root, 'projects', 'sf'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'sf', 'project.json'), '{}');
    const stored = storeImport(root, 'sf', 'one.csv', Buffer.from(rowsCsv([CREATE_LEAD])));
    expect(stored.manifest.links).toBeUndefined();
    expect(stored.manifest.chains).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
