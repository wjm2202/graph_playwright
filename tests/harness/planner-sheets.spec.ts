/**
 * S3.3 — the journey script planner's SHEETS: the New ▾ doors (paste a
 * script, ADO import, from a recording, open a file), Join another graph,
 * Export, ＋ new project, save-to-another-project and the personas "logs in
 * as" step.
 *
 * Two arms, because the planner has two lives:
 *  - file:// (double-clicked tools/planner.html): everything that
 *    needs no network — paste, export, join over the INLINED library — plus
 *    the honest capability notice on the doors that do.
 *  - served (a REAL dev server on a throwaway PLANNER_ROOT):
 *    the ADO wizard end to end, ＋ new project, and the save that creates
 *    personas.json entries. The files left on disk are the assertions.
 *
 * The window type is LOCAL (never `declare global`): each planner spec types
 * only the slice of `window.planner` it drives.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/planner.html')).href;

interface Doc {
  id: string;
  systems: Record<string, { label: string; kind: string; urlEnv?: string }>;
  actors: Record<string, string>;
  nodes: { id: string; type: string; label?: string }[];
  edges: { id: string; from: string; to: string; type: string }[];
  composedFrom?: { ref: string; graphId: string; at: string }[];
}
interface SheetWindow {
  planner: {
    get(): Doc;
    load(g: unknown): { ok: boolean; errors: string[] };
    validate(): { ok: boolean; errors: string[] };
    script(): { text: string; dropped: string[] };
    openFromLibrary(ref: string): boolean;
    saveToProject(project?: string, overwrite?: boolean): Promise<{ ok: boolean; errors?: string[] }>;
    projects(): { list: string[]; current: string };
    importCases: { state(): { project: string; importId: string; results: { graphId: string }[] } };
  };
  P2: {
    state: { doc: Doc; dirty: boolean; sel: { kind: string; id: string } };
    ui: { select(sel: { kind: string; id: string }, open?: boolean): void };
    lib: { script(): { parseScript(t: string): { graph: Doc; problems: { line: number }[] } } };
  };
  PERSONA_ENV: Record<string, Record<string, string> | undefined>;
  __plannerReload?: () => boolean;
  __save?: Promise<{ ok: boolean }>;
}

const boot = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url);
  // ~1.3 MB of inline script: under parallel worker load 30s is honest.
  await page.waitForFunction(() => !!(window as unknown as SheetWindow).planner, undefined, { timeout: 30_000 });
};

/** New ▾ is a pop-over: it has to be open before its entries are clickable. */
const newMenu = async (page: import('@playwright/test').Page, kind: string) => {
  await page.locator('#b_new').click();
  await page.locator(`[data-new="${kind}"]`).click();
};

// ===================================================================
// file:// — no server, no network
// ===================================================================

test.describe('file://', () => {
  test.beforeEach(async ({ page }) => { await boot(page, PLANNER); });

  test('New ▾ → Paste a script: the example drafts two sessions and three steps, dirty', async ({ page }) => {
    await newMenu(page, 'paste');
    await expect(page.locator('#s_txt')).toBeVisible();
    await expect(page.locator('#s_txt')).toHaveValue(/as Client Associate on sf/);
    await page.locator('#s_ok').click();

    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
    const doc = await page.evaluate(() => (window as unknown as SheetWindow).planner.get());
    expect(doc.id).toBe('create_customer');
    expect(doc.nodes.filter((n) => n.type === 'session')).toHaveLength(2);
    expect(doc.edges.filter((e) => ['does', 'denied', 'asserts'].includes(e.type))).toHaveLength(3);
    // A draft exists nowhere on disk — it must open UNSAVED.
    expect(await page.evaluate(() => (window as unknown as SheetWindow).P2.state.dirty)).toBe(true);
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.validate().ok)).toBe(true);
    await expect(page.locator('#doc_meta')).toContainText('2 sessions · 3 steps');
  });

  test('a bad line is reported with its line number and the sheet stays open', async ({ page }) => {
    await newMenu(page, 'paste');
    await page.locator('#s_txt').fill([
      'demo_flow  Demo',
      'as Client Associate on sf',
      '  create Customer (Account)',
      '    ✓ nope.kind whatever',
    ].join('\n'));
    await page.locator('#s_ok').click();

    await expect(page.locator('#sheet')).toHaveClass(/open/);
    await expect(page.locator('#s_problems li')).toHaveCount(1);
    await expect(page.locator('#s_problems li')).toContainText('line 4');
    await expect(page.locator('#s_problems li')).toContainText("unknown check kind 'nope.kind'");
    await expect(page.locator('#s_msg')).toContainText('1 line to look at');
    // Nothing was loaded behind the sheet.
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.get().id)).not.toBe('demo_flow');

    // The rest of the script is sound, so the human may take it anyway.
    await page.locator('#s_force').click();
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.get().id)).toBe('demo_flow');
  });

  test('Export → Copy as script round-trips, and names what the text cannot carry', async ({ page }) => {
    await page.evaluate(() => (window as unknown as SheetWindow).planner.openFromLibrary('lead_to_customer'));
    await page.locator('#b_export').click();
    await page.locator('#s_script').click();
    const text = await page.locator('#s_json').inputValue();
    expect(text).toContain('lead_to_customer');
    expect(text).toMatch(/^\s*as /m);

    // parse(print(g)) is the same script: same sessions, same steps, no problems.
    const round = await page.evaluate((script) => {
      const w = window as unknown as SheetWindow;
      const parsed = w.P2.lib.script().parseScript(script);
      const before = w.planner.get();
      const count = (d: Doc, t: string[]) => ({
        sessions: d.nodes.filter((n) => n.type === 'session').length,
        steps: d.edges.filter((e) => t.includes(e.type)).length,
        records: d.nodes.filter((n) => n.type === 'data').length,
      });
      return {
        problems: parsed.problems,
        before: count(before, ['does', 'denied', 'asserts']),
        after: count(parsed.graph, ['does', 'denied', 'asserts']),
      };
    }, text);
    expect(round.problems).toEqual([]);
    expect(round.after.sessions).toBe(round.before.sessions);
    expect(round.after.records).toBe(round.before.records);

    // lead_to_customer carries api/db/logger evidence nodes: the script form
    // cannot say them, so it SAYS SO rather than losing them silently.
    await expect(page.locator('#s_dropped .warnbox')).toContainText('the script cannot carry');
    const dropped = await page.evaluate(() => (window as unknown as SheetWindow).planner.script().dropped);
    expect(dropped.length).toBeGreaterThan(0);
  });

  test('Join another graph: the picker summarises produces/needs and splices the graph in', async ({ page }) => {
    await page.evaluate(() => (window as unknown as SheetWindow).planner.openFromLibrary('lead_to_customer'));
    await page.locator('#b_join').click();
    await expect(page.locator('#sheet_card h3')).toContainText('Join another graph after');
    // The open graph is never offered to itself.
    await expect(page.locator('#sheet .pick [data-ref="lead_to_customer"]')).toHaveCount(0);
    const expense = page.locator('#sheet .pick [data-ref="expense_to_siebel"]');
    await expect(expense).toContainText('3 sessions');
    await expect(expense).toContainText('produces Expense record');

    const before = await page.evaluate(() => (window as unknown as SheetWindow).planner.get().nodes.length);
    await expense.click();
    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
    await expect(page.locator('#toast')).toContainText('joined expense_to_siebel');

    const doc = await page.evaluate(() => (window as unknown as SheetWindow).planner.get());
    expect(doc.nodes.length).toBeGreaterThan(before);
    expect(doc.composedFrom?.some((c) => c.graphId === 'expense_to_siebel')).toBe(true);
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.validate().ok)).toBe(true);
    // The join lands the human on the first session it added.
    const sel = await page.evaluate(() => (window as unknown as SheetWindow).P2.state.sel);
    expect(sel.kind).toBe('session');
    expect(doc.nodes.find((n) => n.id === sel.id)?.type).toBe('session');
  });

  test('a system-definition clash is refused WITH the fix; aligning and retrying merges the shared record', async ({ page }) => {
    await page.evaluate(() => (window as unknown as SheetWindow).planner.openFromLibrary('lead_to_customer'));
    await page.locator('#b_join').click();
    await page.locator('#sheet .pick [data-ref="salesforce/o2a_tc01_prospect_to_customer"]').click();

    // Refused, in the sheet, with both definitions and the one-click answer.
    await expect(page.locator('#s_join_msg')).toContainText("system 'sf' is defined differently");
    await expect(page.locator('#s_join_msg')).toContainText('Salesforce UAT');
    await expect(page.locator('#s_join_msg')).toContainText('Salesforce SIT');
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.get().composedFrom)).toBeUndefined();

    await page.locator('#s_align').click();
    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
    // 'Lead record' exists in both graphs under the same id: ONE record after.
    await expect(page.locator('#toast')).toContainText('merged lead');

    const doc = await page.evaluate(() => (window as unknown as SheetWindow).planner.get());
    expect(doc.systems.sf!.label).toBe('Salesforce SIT');
    expect(doc.nodes.filter((n) => n.id === 'lead')).toHaveLength(1);
    expect(doc.nodes.filter((n) => n.type === 'session').length).toBe(10);
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.validate().ok)).toBe(true);
  });

  test('the doors that need the dev server say so instead of failing silently', async ({ page }) => {
    await newMenu(page, 'ado');
    await expect(page.locator('#sheet_card')).toContainText('npm run planner');
    await expect(page.locator('#ic_step1')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await newMenu(page, 'rec');
    await expect(page.locator('#sheet_card')).toContainText('recordings/');
    await expect(page.locator('#sheet_card')).toContainText('npm run planner');
    await page.keyboard.press('Escape');

    await newMenu(page, 'project');
    await expect(page.locator('#sheet_card')).toContainText('npm run project:new');
  });
});

// ===================================================================
// served — a real dev server on a sandbox root
// ===================================================================

const CSV =
  'ID,Work Item Type,Title,Steps\n' +
  '11,Test Case,Create customer,"1. As admin, create a new customer | Customer record is created"\n' +
  '12,Test Case,Add address,"1. As admin, add a new address to existing customer | Address saved"\n' +
  '13,Test Case,Verify customer,"1. Open the customer | Customer page is shown"\n';

test.describe('served', () => {
  let child: ChildProcess;
  let base = '';
  let tmp = '';

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-sheets-'));
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify({
      org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
      accounts: { admin: {} },
      personas: { admin: { kind: 'internal', account: 'admin' } },
    }));
    fs.writeFileSync(path.join(tmp, '.env'), '');
    fs.writeFileSync(path.join(tmp, '.env.example'), '# sandbox\n');
    fs.mkdirSync(path.join(tmp, 'recordings', 'lead_to_customer', 'admin-20260901-101500'), { recursive: true });
    child = spawn('node', [path.resolve('tools/serve-planner.mjs')], {
      env: { ...process.env, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('server never announced its port')); }, 20_000);
      child.stdout!.on('data', (buf: Buffer) => {
        const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
        if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
      });
      child.on('exit', (code) => { reject(new Error(`server exited early (${code})`)); });
    });
  });
  test.afterAll(() => {
    child?.kill();
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** fullyParallel: every test makes the projects it needs on its own root. */
  const makeProject = async (name: string) =>
    fetch(`${base}/__projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: name }) });

  test('ADO import: new project → upload → tick two of three → draft graphs on disk, and the reload waits', async ({ page }) => {
    await boot(page, `${base}/`);
    await newMenu(page, 'ado');
    await expect(page.locator('#ic_step1')).toBeVisible();

    // The project is created from inside the wizard (which rebuilds, which
    // would live-reload this tab — the sheet holds it).
    await page.selectOption('#ic_project', '__new');
    await expect(page.locator('#ic_newproject')).toBeVisible();
    await page.locator('#ic_newproject').fill('crm');
    await page.locator('#ic_file').setInputFiles({ name: 'ADO plan.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    expect(await page.evaluate(() => (window as unknown as SheetWindow).__plannerReload!())).toBe(false);
    await page.locator('#ic_read').click();

    await expect(page.locator('#ic_step2')).toBeVisible();
    await expect(page.locator('#ic_summary')).toContainText('ADO plan.csv — 3 test cases, 3 to import into crm');
    const boxes = page.locator('#ic_list input[type=checkbox]');
    await expect(boxes).toHaveCount(3);
    await expect(page.locator('#ic_list')).toContainText('Create customer · 1 step');
    await page.locator('#ic_none').click();
    await expect(boxes.nth(0)).not.toBeChecked();
    await page.locator('#ic_all').click();
    await boxes.nth(2).uncheck(); // leave 'Verify customer' for later
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.importCases.state().project)).toBe('crm');
    await page.locator('#ic_apply').click();

    await expect(page.locator('#ic_step3')).toBeVisible();
    await expect(page.locator('#ic_results')).toContainText('crm/create_customer');
    await expect(page.locator('#ic_results')).toContainText('crm/add_address');
    const graphs = path.join(tmp, 'projects', 'crm', 'graphs');
    expect(fs.readdirSync(graphs).filter((f) => f.endsWith('.graph.json')).sort())
      .toEqual(['add_address.graph.json', 'create_customer.graph.json']);
    // The library rail re-read /__library — the new graphs are listed there
    // even though this build has not re-inlined their documents yet.
    await expect(page.locator('#library')).toContainText('create_customer');
    await expect(page.locator('#toast')).toContainText('imported 2 test cases into projects/crm/graphs/');

    // The leftover case is offered on the next pass, the imported ones locked.
    await page.locator('#ic_more').click();
    await expect(page.locator('#ic_step1')).toBeVisible();
    await expect(page.locator('#ic_project')).toHaveValue('crm');
    const prev = page.locator('#ic_previous option');
    await expect(prev).toHaveCount(2);
    await expect(prev.nth(1)).toContainText('3 cases, 1 not yet imported');
    await page.selectOption('#ic_previous', { index: 1 });
    await expect(page.locator('#ic_filerow')).toBeHidden();
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_summary')).toContainText('3 test cases, 1 to import');
    await expect(page.locator('#ic_list')).toContainText('→ create_customer (imported)');
    await expect(boxes.nth(0)).toBeDisabled();
    await page.locator('#ic_apply').click();
    await expect(page.locator('#ic_results')).toContainText('crm/verify_customer');
    expect(fs.existsSync(path.join(graphs, 'verify_customer.graph.json'))).toBe(true);
  });

  test('refusals stay in the wizard: no project, no file', async ({ page }) => {
    await boot(page, `${base}/`);
    await newMenu(page, 'ado');
    await page.selectOption('#ic_project', '');
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_msg')).toContainText('choose a project');
    await page.selectOption('#ic_project', '__new');
    await page.locator('#ic_newproject').fill('Bad Name');
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_msg')).toContainText('choose the ADO export file');
    await page.locator('#ic_file').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_msg')).toContainText('lower-case');
    await expect(page.locator('#ic_step1')).toBeVisible();
  });

  test('New ▾ → ＋ New project scaffolds projects/<name>/ and makes it current', async ({ page }) => {
    await boot(page, `${base}/`);
    await newMenu(page, 'project');
    await page.locator('#pj_name').fill('Not A Name');
    await page.locator('#pj_make').click();
    await expect(page.locator('#pj_msg')).toContainText('lower-case letters, digits');

    await page.locator('#pj_name').fill('billing');
    await page.locator('#pj_team').fill('Billing squad');
    await page.locator('#pj_make').click();
    await expect(page.locator('#sheet')).not.toHaveClass(/open/);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'projects', 'billing', 'project.json'), 'utf8'));
    expect(manifest).toMatchObject({ project: 'billing', team: 'Billing squad', namePrefix: 'E2E_BILLING' });
    expect(await page.evaluate(() => (window as unknown as SheetWindow).planner.projects().current)).toBe('billing');
    await expect(page.locator('#proj_label')).toContainText('project · billing');
  });

  test('save: a role that is not in personas.json asks who it logs in as, then writes both files', async ({ page }) => {
    await makeProject('billing');
    await boot(page, `${base}/`);
    await page.evaluate(() => {
      (window as unknown as SheetWindow).planner.load({
        schema: 'process-graph/2', id: 'client_flow', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
        actors: { client_associate: 'client_associate', client_lead: 'client_lead' },
        nodes: [
          { id: 'start', type: 'start', label: '' },
          { id: 's1', type: 'session', label: 'Salesforce · client_associate', system: 'sf', actor: 'client_associate' },
          { id: 's2', type: 'session', label: 'Salesforce · client_lead', system: 'sf', actor: 'client_lead' },
          { id: 'end', type: 'end', label: '' },
        ],
        edges: [
          { id: 'l1', from: 'start', to: 's1', type: 'login_as' },
          { id: 'l2', from: 's1', to: 's2', type: 'login_as' },
          { id: 'n', from: 's2', to: 'end', type: 'next' },
        ],
      });
    });
    // The save waits on the sheet — hold the promise and answer it.
    await page.evaluate(() => { (window as unknown as SheetWindow).__save = (window as unknown as SheetWindow).planner.saveToProject('billing'); });
    await expect(page.locator('#pp_cast')).toBeVisible();
    const rows = page.locator('#pp_cast select[data-role]');
    await expect(rows).toHaveCount(2);
    expect(await rows.nth(0).locator('option').first().textContent())
      .toContain('new login: client_associate  (SF_CLIENT_ASSOCIATE_*)');
    // The lead shares the associate's brand-new login.
    await rows.nth(1).selectOption('client_associate');
    await page.locator('#pp_apply').click();

    await expect(page.locator('#pp_result')).toContainText('created in personas.json');
    await expect(page.locator('#pp_env')).toContainText('SF_CLIENT_ASSOCIATE_USERNAME=');
    await expect(page.locator('#pp_apply')).toHaveText('Continue the save');
    await page.locator('#pp_apply').click();

    const res = await page.evaluate(() => (window as unknown as SheetWindow).__save ?? { ok: false });
    expect(res.ok).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'personas.json'), 'utf8'));
    expect(doc.personas.client_associate).toMatchObject({ kind: 'internal', account: 'client_associate' });
    expect(doc.personas.client_lead.account).toBe('client_associate'); // one login, two roles
    expect(doc.accounts.client_lead).toBeUndefined();
    expect(fs.existsSync(path.join(tmp, 'projects', 'billing', 'graphs', 'client_flow.graph.json'))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8')).toContain('SF_CLIENT_ASSOCIATE_USERNAME=');
  });

  test('New ▾ → From a recording lists recordings/ and hands over the pipeline command', async ({ page }) => {
    await boot(page, `${base}/`);
    await newMenu(page, 'rec');
    await expect(page.locator('#rc_list')).toContainText('lead_to_customer');
    await expect(page.locator('#rc_list')).toContainText('1 capture');
    await expect(page.locator('#rc_list')).toContainText('admin');
    await page.locator('[data-journey="lead_to_customer"]').click();
    // Honest: it PREPARES the command, it does not run the pipeline.
    await expect(page.locator('#rc_cmd .cmd')).toHaveText('npx sfpw pipeline lead_to_customer --graph');
    await expect(page.locator('#rc_cmd')).toContainText('does not run the pipeline for you');
    await page.locator('#rc_copy').click();
    await expect(page.locator('#toast')).toContainText('copied the pipeline command');
  });

  test('Save to… offers every project and saves into the one picked', async ({ page }) => {
    await makeProject('crm');
    await makeProject('billing');
    await boot(page, `${base}/`);
    await expect.poll(() => page.evaluate(() => (window as unknown as SheetWindow).planner.projects().list)).toContain('billing');
    await page.evaluate(() => {
      (window as unknown as SheetWindow).planner.load({
        schema: 'process-graph/2', id: 'picked_flow', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
        actors: { a: 'admin' },
        nodes: [
          { id: 'start', type: 'start', label: '' },
          { id: 's1', type: 'session', label: 'Salesforce · a', system: 'sf', actor: 'a' },
          { id: 'end', type: 'end', label: '' },
        ],
        edges: [
          { id: 'l1', from: 'start', to: 's1', type: 'login_as' },
          { id: 'n', from: 's1', to: 'end', type: 'next' },
        ],
      });
    });
    await page.locator('#b_saveas').click();
    await expect(page.locator('#sheet .pick [data-project="crm"]')).toBeVisible();
    await page.locator('#sheet .pick [data-project="billing"]').click();
    await expect(page.locator('#toast')).toContainText('saved projects/billing/graphs/picked_flow.graph.json');
    expect(fs.existsSync(path.join(tmp, 'projects', 'billing', 'graphs', 'picked_flow.graph.json'))).toBe(true);
  });

  // S4.1 port of the deleted planner.spec.ts "env names are editable when
  // served" (parity §4 `nf_creds`): the card names the env VARIABLE, the
  // server rewrites personas.json, and a refusal snaps the input back. Only
  // the server can prove this — a stubbed fetch proves nothing about disk.
  test('a credential env NAME renames through the server; a refusal snaps back', async ({ page }) => {
    await boot(page, `${base}/`);
    await page.evaluate(() => {
      (window as unknown as SheetWindow).planner.load({
        schema: 'process-graph/2', id: 'env_flow', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
        actors: { a: 'admin' },
        nodes: [
          { id: 'start', type: 'start', label: '' },
          { id: 's1', type: 'session', label: 'Salesforce · a', system: 'sf', actor: 'a' },
          { id: 'end', type: 'end', label: '' },
        ],
        edges: [
          { id: 'l1', from: 'start', to: 's1', type: 'login_as' },
          { id: 'n', from: 's1', to: 'end', type: 'next' },
        ],
      });
    });
    // The roster arrives from /__personas, not from the build-time inline.
    await expect.poll(() => page.evaluate(() =>
      (window as unknown as SheetWindow).PERSONA_ENV.admin?.username)).toBe('SF_ADMIN_USERNAME');
    await page.evaluate(() => { (window as unknown as SheetWindow).P2.ui.select({ kind: 'session', id: 's1' }, true); });

    const username = page.locator('#insp .credrow [data-env="username"]');
    await expect(username).toHaveValue('SF_ADMIN_USERNAME');

    await username.fill('SFDC_UAT_USERNAME');
    await username.blur();
    await expect(page.locator('#toast')).toContainText('personas.json updated');
    // Names only — the file on disk is the assertion, and .env is untouched.
    await expect.poll(() =>
      JSON.parse(fs.readFileSync(path.join(tmp, 'personas.json'), 'utf8')).accounts.admin.usernameEnv as string,
    ).toBe('SFDC_UAT_USERNAME');
    expect(fs.readFileSync(path.join(tmp, '.env'), 'utf8')).not.toContain('SFDC_UAT_USERNAME');

    // A value pasted where a NAME belongs is refused before it leaves the page.
    await username.fill('me@example.com');
    await username.blur();
    await expect(page.locator('#toast')).toContainText('an env NAME');
    await expect(username).toHaveValue('SFDC_UAT_USERNAME');
    expect(JSON.parse(fs.readFileSync(path.join(tmp, 'personas.json'), 'utf8')).accounts.admin.usernameEnv)
      .toBe('SFDC_UAT_USERNAME');
  });
});
