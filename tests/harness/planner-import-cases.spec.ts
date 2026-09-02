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
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify({ org: { instanceUrlEnv: 'SF_INSTANCE_URL' }, personas: { admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD' } } }));
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
    interface W { planner: { load(g: unknown): unknown; projects(): { current: string }; saveToProject(p?: string, o?: boolean): Promise<{ ok: boolean }> } }
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

  // A real ADO "Export test cases → Excel" layout (one row per step, title +
  // type only on the case's first row, CRLF-laden cells) through the browser
  // upload path — binary xlsx survives the base64 hop and every case lands.
  test('an ADO Test Plans .xlsx uploads through the dialog and every case becomes a graph', async ({ page }) => {
    const XLSX = await import('xlsx');
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['ID', 'Work Item Type', 'Title', 'Test Step', 'Step Action', 'Step Expected', 'Area Path', 'State'],
      ['90001', 'Test Case', 'L2C-TC01_Req 100001: Verify user can convert a prospect', '', '', '', 'Acme\\Sales', 'Ready'],
      ['', '', '', '1', 'Pre req : Personas who can perform this action: Client Associate', '\r\n', '', ''],
      ['', '', '', '2', 'Login to Salesforce SIT with above personas', '\r\n', '', ''],
      ['', '', '', '3', 'Create New Account during Lead Conversion.\r\n\r\n', 'User should be able to create new account', '', ''],
      ['', '', '', '4', 'Verify Prospect Account is Created.', 'Prospect Account should be created.', '', ''],
      ['90002', 'Test Case', 'L2C-TC02_Req: 100001_Verify type cannot change', '', '', '', 'Acme\\Sales', 'Ready'],
      ['', '', '', '1', 'Login to Salesforce SIT', 'Logged in', '', ''],
      ['', '', '', '2', 'Open the account and change type', 'Error is shown', '', ''],
      ['90035', 'Test Case', 'L2C-TC35-Req100035_Ability to sync (no steps yet)', '', '', '', 'Acme\\Sales', 'Design'],
    ]), 'Test Cases');
    const xlsx = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    await fetch(`${base}/__projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'salesforce' }) });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.locator('#b_cases').click();
    await page.selectOption('#ic_project', 'salesforce');
    await page.locator('#ic_file').setInputFiles({ name: 'acme_sales_test_cases.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: xlsx });
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_step2')).toBeVisible();
    await expect(page.locator('#ic_summary')).toContainText('3 test cases');
    await expect(page.locator('#ic_list')).toContainText('L2C-TC01_Req 100001: Verify user can convert a prospect · 4 steps');
    // A case with no steps in ADO is shown as such and NOT ticked by default.
    await expect(page.locator('#ic_list')).toContainText('no steps in ADO');
    const boxes = page.locator('#ic_list input[type=checkbox]');
    await expect(boxes.nth(2)).not.toBeChecked();
    await expect(page.locator('#ic_summary')).toContainText('2 to import');
    await page.locator('#ic_apply').click();
    await expect(page.locator('#ic_results')).toContainText('salesforce/l2c_tc01_req_100001_verify_user_can_convert_a_pr'); // ids cap at 48 chars
    await expect(page.locator('#ic_results')).toContainText('salesforce/l2c_tc02_req_100001_verify_type_cannot_change');
    const g = JSON.parse(fs.readFileSync(path.join(tmp, 'projects', 'salesforce', 'graphs', 'l2c_tc01_req_100001_verify_user_can_convert_a_pr.graph.json'), 'utf8'));
    // The pre-req and the "login with above personas" rows open the session; the two real steps are the does edges.
    expect(g.nodes.filter((n: { type: string }) => n.type === 'session').map((n: { id: string }) => n.id)).toEqual(['sess_client_associate']);
    expect(g.edges.filter((e: { type: string }) => e.type === 'does')).toHaveLength(2);
  });

  // The owner's first real import produced nothing: the dev server process
  // predated the routes (it does not reload its own code). The page must SAY so.
  test('a stale dev server (no import routes) is named in the dialog and the status bar', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.route('**/__capabilities', (r) => r.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }));
    await page.route('**/__imports', (r) => r.fulfill({ status: 404, contentType: 'text/html', body: '<html>404</html>' }));
    await page.locator('#b_cases').click();
    await expect(page.locator('#status')).toContainText('the running dev server predates this page — stop it (Ctrl+C) and run: npm run planner');
    await page.selectOption('#ic_project', '__new');
    await page.locator('#ic_newproject').fill('stale_check');
    await page.locator('#ic_file').setInputFiles({ name: 'x.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_msg')).toContainText('predates this page');
    await expect(page.locator('#ic_step1')).toBeVisible(); // nothing pretended to succeed
  });

  // After the post-import live reload the human must SEE the list of graphs
  // (owner 2026-09-02) — the results dialog comes back with open buttons and
  // the first graph is on the canvas.
  test('after the reload that follows an import, the results list is back with every graph named', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    // Simulate what icApply leaves for the reload. The rebuilt library would
    // hold the new graphs; here (no rebuild in tests) they are grafted onto
    // GRAPH_LIBRARY as the page boots.
    const project = 'demo';
    const mk = (id: string) => ({
      schema: 'process-graph/2', id, systems: { sf: { label: 'Salesforce', kind: 'salesforce' } }, actors: { a: 'admin' },
      nodes: [{ id: 'start', type: 'start', label: '' }, { id: 'sess', type: 'session', label: 'SF · a', system: 'sf', actor: 'a' }, { id: 'end', type: 'end', label: '' }],
      edges: [{ id: 'l', from: 'start', to: 'sess', type: 'login_as' }, { id: 'n', from: 'sess', to: 'end', type: 'next' }],
    });
    const results = ['one', 'two', 'three'].map((id) => ({ graphId: id, title: 'T ' + id, nodes: 3, edges: 2, flags: [] }));
    await page.addInitScript(([p, graphs]) => {
      let stored: Record<string, unknown> | undefined;
      Object.defineProperty(window, 'GRAPH_LIBRARY', {
        configurable: true,
        get() { return stored; },
        set(v: Record<string, unknown>) { stored = Object.assign(v, graphs); },
      });
      void p;
    }, [project, Object.fromEntries(results.map((r) => [`${project}/${r.graphId}`, mk(r.graphId)]))] as const);
    await page.evaluate(([p, r]) => { sessionStorage.setItem('planner.lastImport', JSON.stringify({ project: p, results: r })); }, [project, results] as const);
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await expect(page.locator('#p_cases')).toBeVisible();
    await expect(page.locator('#ic_step3')).toBeVisible();
    for (const r of results) await expect(page.locator('#ic_results')).toContainText(`${project}/${r.graphId}`);
    await expect(page.locator('#status')).toContainText(`imported ${results.length} graph`);
    expect(await page.evaluate(() => (window as unknown as { planner: { get(): { id: string } } }).planner.get().id)).toBe(results[0]!.graphId);
    expect(await page.evaluate(() => (window as unknown as { planner: { projects(): { current: string } } }).planner.projects().current)).toBe(project);
  });

  // Owner 2026-09-02: "the window closed on me" — creating the project from
  // inside the wizard triggers a rebuild + live reload. The reload must WAIT
  // while the wizard is on step 1/2, then fire once the import is done.
  test('a live-reload event during the wizard is held until the import completes', async ({ page }) => {
    await fetch(`${base}/__projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'held' }) });
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.evaluate(() => { (window as unknown as { __marker?: number }).__marker = 1; });
    await page.locator('#b_cases').click();
    await page.selectOption('#ic_project', 'held');
    await page.locator('#ic_file').setInputFiles({ name: 'plan.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) });
    await page.locator('#ic_read').click();
    await expect(page.locator('#ic_step2')).toBeVisible();

    // The server's reload message arrives mid-wizard: held, not obeyed.
    const obeyed = await page.evaluate(() => (window as unknown as { __plannerReload(): boolean }).__plannerReload());
    expect(obeyed).toBe(false);
    await expect(page.locator('#ic_step2')).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1); // same page, no reload

    // Finishing the import releases it: the page reloads now.
    await page.locator('#ic_apply').click();
    await page.waitForFunction(() => (window as unknown as { __marker?: number }).__marker === undefined, undefined, { timeout: 15_000 });
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    expect(fs.existsSync(path.join(tmp, 'projects', 'held', 'graphs', 'create_customer.graph.json'))).toBe(true);
  });

  // Owner 2026-09-02: "when I create a new graph I should be able to add
  // personas to select … paste in personas to select from".
  test('personas: paste the ADO role list → roles in the graph + personas.json entries; the session card offers them', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner);
    await page.evaluate(() => { (window as unknown as { planner: { newGraph(f: boolean): void } }).planner.newGraph(true); });
    await page.selectOption('#b_add', '__personas');
    await expect(page.locator('#p_personas')).toBeVisible();
    await expect(page.locator('#pp_roster')).toContainText('admin'); // the sandbox roster
    await page.locator('#pp_paste').fill('Pre req : Personas who can perform this action:  Client Associate, Client Lead, Business Development Manager');
    // Roles → logins: each new role picks the account it plays as; the BDM shares the lead's login.
    await expect(page.locator('#pp_castwrap')).toBeVisible();
    const castRows = page.locator('#pp_cast select[data-role]');
    await expect(castRows).toHaveCount(3);
    expect(await castRows.nth(1).locator('option').first().textContent()).toContain('new login: client_lead  (SF_CLIENT_LEAD_*)');
    await castRows.nth(2).selectOption('client_lead');
    await page.locator('#pp_apply').click();
    await expect(page.locator('#pp_result')).toContainText('added to this graph: client_associate, client_lead, business_development_manager');
    await expect(page.locator('#pp_result')).toContainText('created in personas.json: client_associate, client_lead, business_development_manager → login client_lead');
    await expect(page.locator('#pp_result')).toContainText('new logins: client_associate, client_lead — paste the block below into .env');
    // The paste-ready .env block: one per LOGIN, names only.
    const envText = await page.locator('#pp_env').textContent();
    expect(envText).toContain('# client_lead — salesforce login for: Client Lead, Business Development Manager');
    expect(envText).toContain('SF_CLIENT_LEAD_USERNAME=');
    expect(envText).not.toContain('SF_BUSINESS_DEVELOPMENT_MANAGER');
    const actors = await page.evaluate(() => (window as unknown as { planner: { get(): { actors: Record<string, string> } } }).planner.get().actors);
    expect(actors).toEqual({ client_associate: 'client_associate', client_lead: 'client_lead', business_development_manager: 'business_development_manager' });
    const doc = JSON.parse(fs.readFileSync(path.join(tmp, 'personas.json'), 'utf8'));
    expect(doc.personas.client_lead).toEqual({ kind: 'internal', role: 'Client Lead', account: 'client_lead' });
    expect(doc.personas.business_development_manager.account).toBe('client_lead');
    expect(doc.accounts.client_lead).toEqual({ auth: 'frontdoor' });
    expect(doc.accounts.business_development_manager).toBeUndefined();
    // Reopening shows the binding in the roster:
    await page.locator('#pp_close').click();
    await page.selectOption('#b_add', '__personas');
    await expect(page.locator('#pp_roster')).toContainText('business_development_manager Business Development Manager → login client_lead');
    await page.locator('#pp_close').click();

    // The session card: the graph's roles first, then the rest of the roster.
    const sess = await page.evaluate(() => (window as unknown as { planner: { addTyped(t: string): string; select(id: string): void } }).planner.addTyped('session'));
    await page.evaluate((id) => { (window as unknown as { planner: { select(id: string): void } }).planner.select(id); }, sess);
    const options = await page.locator('#nf_actor option').allTextContents();
    expect(options).toContain('client_associate → client_associate');
    const roster = await page.locator('#nf_actor optgroup[label="from personas.json (adds the role)"] option').allTextContents();
    expect(roster).toContain('admin');
    expect(roster).not.toContain('client_lead'); // already a role in this graph
    // Picking a roster persona from the card adds the role on the spot.
    await page.selectOption('#nf_actor', 'roster:admin');
    await page.locator('#nf_actor').dispatchEvent('change');
    const after = await page.evaluate(() => (window as unknown as { planner: { get(): { actors: Record<string, string>; nodes: { id: string; actor?: string }[] } } }).planner.get());
    expect(after.actors.admin).toBe('admin');
    expect(after.nodes.find((n) => n.id === sess)!.actor).toBe('admin');

    // The credentials card says which LOGIN a role uses and who else shares it (after the rebuild lands the new roster).
    await page.selectOption('#nf_actor', 'business_development_manager');
    await page.locator('#nf_actor').dispatchEvent('change');
    await expect(page.locator('#nf_creds')).toContainText('login', { timeout: 15_000 });
    await expect(page.locator('#nf_creds')).toContainText('client_lead');
    await expect(page.locator('#nf_creds')).toContainText('also plays client_lead');
    await expect(page.locator('#nf_creds input[data-cred="username"]')).toHaveValue('SF_CLIENT_LEAD_USERNAME'); // the LOGIN's names, not SF_BUSINESS_DEVELOPMENT_MANAGER_*
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
