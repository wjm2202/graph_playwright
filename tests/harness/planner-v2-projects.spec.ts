/**
 * S3.4 — the v2 port of `tests/harness/planner-projects.spec.ts`
 * (DESIGN-PROJECTS.md §3).
 *
 * The controls moved, the behaviour did not. Where v1 had a grouped TOOLBAR
 * and a `#f_project` dropdown, v2 has the top bar plus the LIBRARY RAIL: the
 * library is grouped by project, `＋ New project…` lives on New ▾, and the
 * current project is `window.planner.projects().current` exactly as before
 * (parity §3 `f_project`). So the v1 rows that asserted `header .tbg`,
 * `#f_library optgroup` and `#f_project` are asserted here against the top
 * bar, the `.lib .proj` group headings and the New ▾ entry — noted per test.
 *
 * The served arm uses a REAL dev server on a throwaway root, like
 * planner-v2-sheets.spec.ts, because a stubbed `fetch` proves the UI talks to
 * something, not that projects land on disk.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/journey-planner.html')).href;

interface ProjWindow {
  planner: {
    projects(): { list: string[]; current: string };
    setProject(p: string): void;
    graphProject(): string;
    library(): { builtIn: string[]; saved: string[] };
    openFromLibrary(ref: string): boolean;
    get(): { id: string };
  };
  GRAPH_LIBRARY: Record<string, unknown>;
  P2: {
    state: { library: { projects: { name: string; graphs: unknown[] }[]; legacy: unknown[] }; project: string; ref: string };
    net: { localLibrary(): unknown };
    library: { render(): void; filter(name?: string): string; graphsTouching(name: string): string[] };
    ui: { render(): void };
  };
}

const boot = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as unknown as ProjWindow).planner, undefined, { timeout: 30_000 });
};

// ===================================================================
// file:// — the shell, the rail and the honest refusal
// ===================================================================

test.describe('file://', () => {
  test.beforeEach(async ({ page }) => { await boot(page, PLANNER); });

  // v1: 'toolbar is grouped by workflow — every original control keeps its id'.
  // v2 has no toolbar groups; the same controls live on the top bar and the
  // canvas footer, and THAT is what must not disappear.
  test('every top-bar and canvas control the parity table names is on the page', async ({ page }) => {
    for (const id of ['b_new', 'b_join', 'b_undo', 'b_save', 'b_saveas', 'b_export', 'b_mode', 'b_help']) {
      await expect(page.locator(`.top #${id}`), `#${id} should be on the top bar`).toHaveCount(1);
    }
    for (const id of ['b_fit', 'b_layout', 'b_graphcard2']) {
      await expect(page.locator(`.cfoot #${id}`), `#${id} should be on the canvas footer`).toHaveCount(1);
    }
    // New ▾ carries every door v1 spread across file ▾ / edit ▾.
    await page.locator('#b_new').click();
    for (const kind of ['blank', 'paste', 'ado', 'rec', 'file', 'project']) {
      await expect(page.locator(`[data-new="${kind}"]`)).toBeVisible();
    }
  });

  // v1: 'project selector: all-projects default plus the create option'.
  test('no project is current until one is chosen, and ＋ New project… is the create door', async ({ page }) => {
    const state = await page.evaluate(() => (window as unknown as ProjWindow).planner.projects());
    expect(state.current).toBe('');
    await page.locator('#b_new').click();
    await expect(page.locator('[data-new="project"]')).toContainText('New project');
  });

  // v1: 'library groups by project and the selector filters it'.
  test('the library rail groups by project, bare ids on the row, full ref on the click', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as ProjWindow;
      w.GRAPH_LIBRARY = {
        legacy_flow: { schema: 'process-graph/2', id: 'legacy_flow', systems: {}, actors: {}, nodes: [], edges: [] },
        'web/checkout': { schema: 'process-graph/2', id: 'checkout', systems: {}, actors: {}, nodes: [], edges: [] },
        'siebel/sync': { schema: 'process-graph/2', id: 'sync', systems: {}, actors: {}, nodes: [], edges: [] },
      };
      w.P2.state.library = w.P2.net.localLibrary() as ProjWindow['P2']['state']['library'];
      w.P2.ui.render();
    });
    // Projects keep the order the library reports them in; what matters is
    // that each is its own group and the un-projected graphs are the last.
    const groups = await page.locator('#library .proj').allInnerTexts();
    expect(groups.slice(0, 2).sort()).toEqual(['projects / siebel', 'projects / web']);
    expect(groups[2]).toBe('journeys / graphs');
    expect((await page.locator('#library .item .name').allInnerTexts()).sort()).toEqual(['checkout', 'legacy_flow', 'sync']);

    // Opening a project graph adopts its project — v1's `f_project` filter.
    await page.locator('#library .item').filter({ hasText: 'checkout' }).click();
    expect(await page.evaluate(() => (window as unknown as ProjWindow).planner.graphProject())).toBe('web');
  });

  // NEW in S3.4 (parity §1 library row): the record ledger is a filter.
  test('clicking a record in the ledger filters the library to the graphs that touch it', async ({ page }) => {
    await page.evaluate(() => {
      const w = window as unknown as ProjWindow;
      const graph = (id: string, record: string) => ({
        schema: 'process-graph/2', id, systems: { sf: { label: 'SF', kind: 'salesforce' } }, actors: { admin: 'admin' },
        nodes: [
          { id: 'start', type: 'start', label: '' },
          { id: 'sess', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
          { id: 'rec', type: 'data', label: record },
          { id: 'end', type: 'end', label: '' },
        ],
        edges: [
          { id: 'l1', from: 'start', to: 'sess', type: 'login_as' },
          { id: 'd1', from: 'sess', to: 'rec', type: 'does', label: 'create ' + record, data: { catalog: 'r.create' } },
          { id: 'n1', from: 'sess', to: 'end', type: 'next' },
        ],
      });
      w.GRAPH_LIBRARY = { 'p/one': graph('one', 'Alpha'), 'p/two': graph('two', 'Beta') };
      w.P2.state.library = w.P2.net.localLibrary() as ProjWindow['P2']['state']['library'];
      w.planner.openFromLibrary('p/one');
    });
    await expect(page.locator('#library .item')).toHaveCount(2);

    // One line per record: `name · SObject` left, `↑ n · ↓ m` right.
    const row = page.locator('#ledger .row').filter({ hasText: 'Beta' });
    await expect(row.locator('.who')).toContainText('↑ 1');
    await row.click();
    await expect(page.locator('#library .item .name')).toHaveText(['two']);
    await expect(page.locator('#ledger .filterbar')).toContainText('filtered by Beta');

    await row.click();                      // toggles off
    await expect(page.locator('#library .item')).toHaveCount(2);
  });

  // v1: 'file:// cannot create projects — the flow says how'.
  test('file:// cannot create a project — the sheet says which command does', async ({ page }) => {
    await page.locator('#b_new').click();
    await page.locator('[data-new="project"]').click();
    await expect(page.locator('#sheet')).toHaveClass(/open/);
    await expect(page.locator('#sheet_card')).toContainText('dev server');
    expect(await page.evaluate(() => (window as unknown as ProjWindow).planner.projects().current)).toBe('');
  });
});

// ===================================================================
// served — a real dev server, a real projects/ directory
// ===================================================================

test.describe('served', () => {
  let child: ChildProcess;
  let base = '';
  let tmp = '';

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-v2-projects-'));
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify({
      org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
      personas: { admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD' } },
    }));
    fs.writeFileSync(path.join(tmp, '.env'), '');
    fs.writeFileSync(path.join(tmp, '.env.example'), '# sandbox\n');
    child = spawn('node', [path.resolve(ROOT, 'tools/serve-planner.mjs')], {
      env: { ...process.env, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1', PLANNER_V2: '1' },
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

  // v1: 'served mode: name it once and the project exists — selector adopts it'.
  test('＋ New project scaffolds projects/<name>/ and makes it current', async ({ page }) => {
    await boot(page, `${base}/`);
    await page.locator('#b_new').click();
    await page.locator('[data-new="project"]').click();
    await page.locator('#pj_name').fill('o2_provisioning');
    await page.locator('#pj_make').click();

    await expect.poll(async () => fs.existsSync(path.join(tmp, 'projects', 'o2_provisioning')), { timeout: 10_000 }).toBe(true);
    await expect.poll(async () => page.evaluate(() => (window as unknown as ProjWindow).planner.projects().current)).toBe('o2_provisioning');
    const state = await page.evaluate(() => (window as unknown as ProjWindow).planner.projects());
    expect(state.list).toContain('o2_provisioning');
  });

  // v1: 'served refusal surfaces the server reason and keeps the selector honest'.
  test('a refused name surfaces the server\'s own reason and creates nothing', async ({ page }) => {
    await boot(page, `${base}/`);
    await page.locator('#b_new').click();
    await page.locator('[data-new="project"]').click();
    await page.locator('#pj_name').fill('Bad Name');
    await page.locator('#pj_make').click();

    await expect(page.locator('#sheet_card')).toContainText('lower-case letters');
    expect(fs.existsSync(path.join(tmp, 'projects', 'Bad Name'))).toBe(false);
    expect(await page.evaluate(() => (window as unknown as ProjWindow).planner.projects().current)).not.toBe('Bad Name');
  });
});
