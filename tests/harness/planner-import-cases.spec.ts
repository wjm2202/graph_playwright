/**
 * import cases — the planner's door for an ADO export (owner, 2026-09-02):
 * pick/create a project, upload the .xlsx/.csv (stored under the project),
 * tick the test cases, one draft graph each. Driven against the REAL dev
 * server on a sandbox root, so the files it leaves behind are asserted.
 * file:// mode says what to run instead.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const PLANNER_FILE = pathToFileURL(path.resolve('tools/process-planner.html')).href;

const CSV =
  'ID,Work Item Type,Title,Steps\n' +
  '11,Test Case,Create customer,"1. As admin, create a new customer | Customer record is created"\n' +
  '12,Test Case,Add address,"1. As admin, add a new address to existing customer | Address saved"\n' +
  '13,Test Case,Verify customer,"1. Open the customer | Customer page is shown"\n';

test('file:// mode: the button explains it needs the dev server', async ({ page }) => {
  await page.goto(PLANNER_FILE);
  await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
  await page.locator('#b_cases').click();
  await expect(page.locator('#p_cases')).toBeHidden();
  await expect(page.locator('#status')).toContainText('needs the dev server — run: npm run planner');
});

test.describe('served', () => {
  let child: ChildProcess;
  let base = '';
  let tmp = '';

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-import-'));
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify({ personas: { admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD' } } }));
    fs.writeFileSync(path.join(tmp, '.env'), '');
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

  test('new project → upload → pick two of three → graphs on disk; the stored import reopens with the leftover', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.locator('#b_cases').click();
    await expect(page.locator('#p_cases')).toBeVisible();

    // Create the project from inside the dialog.
    await page.selectOption('#ic_project', '__new');
    await expect(page.locator('#ic_newproject')).toBeVisible();
    await page.locator('#ic_newproject').fill('crm');
    await page.locator('#ic_file').setInputFiles({ name: 'ADO plan.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.locator('#ic_read').click();

    // Step 2: every case listed, ticked by default.
    await expect(page.locator('#ic_step2')).toBeVisible();
    await expect(page.locator('#ic_summary')).toContainText('ADO plan.csv — 3 test cases, 3 to import into crm');
    const boxes = page.locator('#ic_list input[type=checkbox]');
    await expect(boxes).toHaveCount(3);
    await expect(page.locator('#ic_list')).toContainText('Create customer · 1 step');
    await boxes.nth(2).uncheck(); // leave 'Verify customer' for later
    await page.locator('#ic_apply').click();

    // Step 3: results name the graphs; disk agrees; manifest stamped.
    await expect(page.locator('#ic_step3')).toBeVisible();
    await expect(page.locator('#ic_results')).toContainText('crm/create_customer');
    await expect(page.locator('#ic_results')).toContainText('crm/add_address');
    await expect(page.locator('#status')).toContainText('imported 2 test cases into projects/crm/graphs/');
    const graphs = path.join(tmp, 'projects', 'crm', 'graphs');
    expect(fs.readdirSync(graphs).filter((f) => f.endsWith('.graph.json')).sort()).toEqual(['add_address.graph.json', 'create_customer.graph.json']);
    const imports = path.join(tmp, 'projects', 'crm', 'imports');
    const manifestFile = fs.readdirSync(imports).find((f) => f.endsWith('.json'))!;
    const manifest = JSON.parse(fs.readFileSync(path.join(imports, manifestFile), 'utf8'));
    expect(manifest.originalName).toBe('ADO plan.csv');
    expect(manifest.cases.map((c: { graphId?: string }) => c.graphId)).toEqual(['create_customer', 'add_address', undefined]);
    expect(fs.readFileSync(path.join(imports, manifest.file), 'utf8')).toBe(CSV); // verbatim

    // Reopen: the stored import is offered, with the one left over.
    await page.locator('#ic_more').click();
    await expect(page.locator('#ic_step1')).toBeVisible();
    await expect(page.locator('#ic_project')).toHaveValue('crm');
    const prev = page.locator('#ic_previous option');
    await expect(prev).toHaveCount(2);
    await expect(prev.nth(1)).toContainText('ADO plan.csv');
    await expect(prev.nth(1)).toContainText('3 cases, 1 not yet imported');
    await page.selectOption('#ic_previous', { index: 1 });
    await expect(page.locator('#ic_filerow')).toBeHidden(); // no re-upload
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_step2')).toBeVisible();
    await expect(page.locator('#ic_summary')).toContainText('3 test cases, 1 to import');
    await expect(page.locator('#ic_list')).toContainText('→ create_customer (imported)');
    await expect(boxes.nth(0)).toBeDisabled();
    await expect(boxes.nth(2)).toBeChecked();
    await page.locator('#ic_apply').click();
    await expect(page.locator('#ic_results')).toContainText('crm/verify_customer');
    expect(fs.existsSync(path.join(graphs, 'verify_customer.graph.json'))).toBe(true);
  });

  // Owner 2026-09-02: "set save up so that it does this for us" — save ▾ writes
  // straight into projects/<p>/graphs/ through the dev server; browser saves
  // stay as the offline fallback.
  test('save ▾ → save to project writes projects/<p>/graphs/<id>.graph.json; a second save asks before overwriting', async ({ page }) => {
    await fetch(`${base}/__projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'drawn' }) });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    type W = { planner: { load(g: unknown): unknown; projects(): { current: string }; saveToProject(p?: string, o?: boolean): Promise<{ ok: boolean }> } };
    await page.evaluate(() => {
      (window as unknown as W).planner.load({
        schema: 'process-graph/2', id: 'by_hand', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } }, actors: { a: 'admin' },
        nodes: [
          { id: 'start', type: 'start', label: '' },
          { id: 'sess', type: 'session', label: 'SF · a', system: 'sf', actor: 'a' },
          { id: 'rec', type: 'data', label: 'Record', sobject: 'Account' },
          { id: 'end', type: 'end', label: '' },
        ],
        edges: [
          { id: 'l', from: 'start', to: 'sess', type: 'login_as' },
          { id: 'd', from: 'sess', to: 'rec', type: 'does', data: { catalog: 'rec.create', io: 'produces' } },
          { id: 'n', from: 'rec', to: 'end', type: 'next' },
        ],
      });
    });
    // Toolbar project = drawn → the save menu offers it first.
    await page.selectOption('#f_project', 'drawn');
    await page.locator('#f_save').dispatchEvent('mousedown');
    await expect(page.locator('#f_save option').nth(1)).toHaveText('save to project "drawn"');
    await page.selectOption('#f_save', 'project:drawn');
    await expect(page.locator('#status')).toContainText('saved projects/drawn/graphs/by_hand.graph.json');
    const file = path.join(tmp, 'projects', 'drawn', 'graphs', 'by_hand.graph.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).id).toBe('by_hand');

    // Second save: the server says it exists; declining keeps the file, accepting overwrites.
    page.once('dialog', (d) => { void d.dismiss(); });
    await page.selectOption('#f_save', 'project:drawn');
    await expect(page.locator('#status')).toContainText('save cancelled — "drawn/by_hand" kept as it was');
    page.once('dialog', (d) => { void d.accept(); });
    await page.selectOption('#f_save', 'project:drawn');
    await expect(page.locator('#status')).toContainText('overwrote projects/drawn/graphs/by_hand.graph.json');

    // Invalid graphs never reach the disk.
    await page.evaluate(() => { (window as unknown as { G: { id: string } }).G.id = 'Bad Id'; });
    const r = await page.evaluate(() => (window as unknown as W).planner.saveToProject('drawn'));
    expect(r.ok).toBe(false);
    await expect(page.locator('#status')).toContainText('cannot save an invalid graph');
  });

  test('refusals stay in the dialog: no project, no file, a bad new-project name', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.locator('#b_cases').click();
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
});
