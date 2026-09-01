/**
 * Excel door + import store for ADO test cases (owner, 2026-09-02: "import
 * test cases into a project"). Pins:
 *  - casesFromRows: query layout (Steps XML) and Test-Plans step-per-row
 *    layout, header found below a cover row, non-test-case rows skipped;
 *  - parseAdoXlsx: real workbook via SheetJS, cover sheet skipped, ids stay
 *    text; parseAdoFile routes by extension;
 *  - store: file kept verbatim + manifest; list newest first; apply writes
 *    graphs into projects/<p>/graphs, stamps the manifest, refuses a second
 *    import of the same case and unknown indexes; missing project refused.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as XLSX from 'xlsx';
import { casesFromRows } from '../../src/graph/fromAdo';
import { parseAdoFile, parseAdoXlsx } from '../../src/graph/fromAdoXlsx';
import { applyImport, listImports, storeImport } from '../../src/graph/adoImports';
import { validateGraph } from '../../src/graph/schema';

const STEPS_XML =
  '<steps id="0" last="2"><step id="1" type="ActionStep"><parameterizedString isformatted="true">&lt;DIV&gt;As a sales user, create a new lead&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">Lead record is created</parameterizedString></step>' +
  '<step id="2" type="ActionStep"><parameterizedString isformatted="true">Convert the lead</parameterizedString><parameterizedString isformatted="true">Account exists</parameterizedString></step></steps>';

test.describe('casesFromRows', () => {
  test('query layout: one row per case, Steps XML', () => {
    const cases = casesFromRows([
      ['ID', 'Work Item Type', 'Title', 'Steps'],
      ['101', 'Test Case', 'Lead to customer', STEPS_XML],
      ['102', 'Requirement', 'Not a test', ''],
      ['103', 'Test Case', 'Empty case', ''],
    ]);
    expect(cases).toEqual([
      { id: '101', title: 'Lead to customer', steps: [
        { action: 'As a sales user, create a new lead', expected: 'Lead record is created' },
        { action: 'Convert the lead', expected: 'Account exists' },
      ] },
      { id: '103', title: 'Empty case', steps: [] },
    ]);
  });

  test('Test Plans layout: step-per-row, title only on the first row, header below a cover row', () => {
    const cases = casesFromRows([
      ['Exported from Azure DevOps', '', '', '', '', ''],
      ['ID', 'Work Item Type', 'Title', 'Test Step', 'Step Action', 'Step Expected'],
      ['201', 'Test Case', 'Create customer', '1', 'As admin, create a customer', 'Customer record is created'],
      ['', '', '', '2', 'Open the customer', 'Customer page is shown'],
      ['', '', '', '', '', 'and the toast says saved'], // expected-only continuation
      ['202', 'Test Case', 'Add address', '1', 'Add a new address to existing customer', 'Address saved'],
      ['202', 'Test Case', 'Add address', '2', 'Verify address', 'Address is shown'], // repeated title/id rows group too
    ]);
    expect(cases).toEqual([
      { id: '201', title: 'Create customer', steps: [
        { action: 'As admin, create a customer', expected: 'Customer record is created' },
        { action: 'Open the customer', expected: 'Customer page is shown and the toast says saved' },
      ] },
      { id: '202', title: 'Add address', steps: [
        { action: 'Add a new address to existing customer', expected: 'Address saved' },
        { action: 'Verify address', expected: 'Address is shown' },
      ] },
    ]);
  });

  test('no Title column anywhere is a loud error; an empty grid is no cases', () => {
    expect(() => casesFromRows([['a', 'b'], ['1', '2']])).toThrow(/no 'Title' column — got: a, b/);
    expect(casesFromRows([])).toEqual([]);
  });
});

test.describe('parseAdoXlsx', () => {
  function workbook(): Buffer {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Cover', 'sheet'], ['nothing', 'here']]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['ID', 'Work Item Type', 'Title', 'Test Step', 'Step Action', 'Step Expected'],
      [301, 'Test Case', 'Lead to customer', 1, 'As a sales user, create a new lead', 'Lead record is created'],
      ['', '', '', 2, 'Convert the lead', 'Account exists'],
      ['00Q000000000001', 'Test Case', 'Open existing lead', 1, 'Open the lead 00Q000000000001', 'Lead page shown'],
    ]), 'Test Cases');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  }

  test('reads the first sheet with a Title header, skipping the cover; numeric-looking cells stay text', () => {
    const r = parseAdoXlsx(workbook());
    expect(r.sheet).toBe('Test Cases');
    expect(r.skippedSheets).toEqual(['Summary']);
    expect(r.cases.map((c) => [c.id, c.title, c.steps.length])).toEqual([['301', 'Lead to customer', 2], ['00Q000000000001', 'Open existing lead', 1]]);
    expect(r.cases[0]!.steps[1]).toEqual({ action: 'Convert the lead', expected: 'Account exists' });
  });

  test('a workbook with no Title sheet fails loudly; parseAdoFile routes csv vs xlsx', () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b']]), 'Only');
    expect(() => parseAdoXlsx(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer)).toThrow(/no sheet with a 'Title' column \(looked at: Only\)/);
    const csv = parseAdoFile('export.csv', Buffer.from('﻿ID,Title,Steps\n9,"From csv",\n'));
    expect(csv).toEqual({ cases: [{ id: '9', title: 'From csv', steps: [] }], sheet: 'csv', skippedSheets: [] });
    expect(parseAdoFile('Export.XLSX', workbook()).sheet).toBe('Test Cases');
  });
});

test.describe('import store', () => {
  let root = '';
  test.beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ado-imports-'));
    fs.mkdirSync(path.join(root, 'projects', 'crm', 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'projects', 'crm', 'project.json'), JSON.stringify({ project: 'crm' }));
  });
  test.afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  const CSV = Buffer.from(
    'ID,Work Item Type,Title,Steps\n' +
    `101,Test Case,Lead to customer,"${STEPS_XML.replace(/"/g, '""')}"\n` +
    '102,Test Case,Add address,"1. As admin, add a new address to existing customer | Address saved"\n' +
    '103,Test Case,Lead to customer,\n', // same title as #101 — id disambiguates the graph id
  );

  test('store keeps the file verbatim + a manifest; list is newest first; a missing project is refused', () => {
    const first = storeImport(root, 'crm', 'My Plan.csv', CSV, new Date('2026-09-02T10:00:00Z'));
    expect(first.manifest).toMatchObject({
      id: '20260902-100000-my_plan', file: '20260902-100000-my_plan.csv', originalName: 'My Plan.csv', sheet: 'csv',
      cases: [
        { index: 0, id: '101', title: 'Lead to customer', steps: 2 },
        { index: 1, id: '102', title: 'Add address', steps: 1 },
        { index: 2, id: '103', title: 'Lead to customer', steps: 0 },
      ],
    });
    const dir = path.join(root, 'projects', 'crm', 'imports');
    expect(fs.readFileSync(path.join(dir, first.manifest.file))).toEqual(CSV);
    expect(JSON.parse(fs.readFileSync(path.join(dir, `${first.manifest.id}.json`), 'utf8'))).toEqual(first.manifest);

    storeImport(root, 'crm', 'later.csv', CSV, new Date('2026-09-03T10:00:00Z'));
    expect(listImports(root, 'crm').map((m) => m.originalName)).toEqual(['later.csv', 'My Plan.csv']);

    expect(() => storeImport(root, 'nope', 'x.csv', CSV)).toThrow(/project 'nope' does not exist/);
    expect(() => storeImport(root, 'Bad Name', 'x.csv', CSV)).toThrow(/lower_snake_case/);
    expect(() => storeImport(root, 'crm', 'empty.csv', Buffer.from('ID,Title\n'))).toThrow(/holds no test cases/);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith('empty'))).toEqual([]); // nothing left behind
  });

  test('apply writes valid draft graphs into projects/<p>/graphs, stamps the manifest, and refuses repeats', () => {
    const { manifest } = storeImport(root, 'crm', 'plan.csv', CSV, new Date('2026-09-02T10:00:00Z'));
    const r = applyImport(root, 'crm', manifest.id, [2, 0, 0], { knownPersonas: ['admin'], now: new Date('2026-09-02T11:00:00Z') });
    expect(r.results.map((x) => [x.index, x.graphId])).toEqual([[0, 'lead_to_customer'], [2, 'lead_to_customer_103']]);
    for (const x of r.results) {
      const g = JSON.parse(fs.readFileSync(x.graphFile, 'utf8'));
      expect(validateGraph(g).ok).toBe(true);
      expect(g.id).toBe(x.graphId);
      expect(path.dirname(x.graphFile)).toBe(path.join(root, 'projects', 'crm', 'graphs'));
    }
    expect(r.results[0]!.nodes).toBeGreaterThan(3);
    expect(r.results[0]!.flags.join('\n')).toMatch(/produces the Lead record/);

    const stored = listImports(root, 'crm')[0]!;
    expect(stored.cases[0]).toMatchObject({ graphId: 'lead_to_customer', importedAt: '2026-09-02T11:00:00.000Z' });
    expect(stored.cases[1]!.graphId).toBeUndefined(); // skipped today, importable tomorrow
    expect(stored.cases[2]).toMatchObject({ graphId: 'lead_to_customer_103' });

    expect(() => applyImport(root, 'crm', manifest.id, [0])).toThrow(/case #0 'Lead to customer' was already imported as 'lead_to_customer'/);
    expect(() => applyImport(root, 'crm', manifest.id, [7])).toThrow(/case #7 is not in import/);
    expect(() => applyImport(root, 'crm', 'ghost', [0])).toThrow(/import 'ghost' not found/);
    // The refused calls wrote nothing new.
    expect(fs.readdirSync(path.join(root, 'projects', 'crm', 'graphs')).sort()).toEqual(['lead_to_customer.graph.json', 'lead_to_customer_103.graph.json']);

    // The one left behind imports later from the stored file — no re-upload.
    const again = applyImport(root, 'crm', manifest.id, [1]);
    expect(again.results[0]!.graphId).toBe('add_address');
  });
});
