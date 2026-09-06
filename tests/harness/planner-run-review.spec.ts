/**
 * M3 — Run this graph → review in Journey Studio, driven through the REAL
 * served planner (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §3.3).
 *
 * A real dev server on a throwaway root; PLANNER_RUN_CMD is a stub that
 * writes a Playwright-shaped results.json (no org, no browser); the ingest is
 * the genuine vendored Journey Studio. What is asserted is the CONTRACT the
 * user sees: the strip's button runs, a review tab opens AT THE CLICK (a user
 * gesture, so no popup blocker) and lands on the review when the run is done,
 * the pill that appears is an <a> whose href is exactly
 * `/studio/studio.html?batch=<batch>&slug=<slug>` — same origin, the studio is
 * MOUNTED in the planner — the failing test is a red pill with its error, and
 * the dashboard link is there. Over file:// the button still copies the
 * command — nothing regressed.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/planner.html')).href;

const PERSONAS = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: {},
  accounts: { sales: { usernameEnv: 'SF_SALES_USERNAME', passwordEnv: 'SF_SALES_PASSWORD', tokenEnv: '' } },
  personas: { sales_user: { kind: 'internal', account: 'sales' } },
};

/**
 * A complete one-session graph — the strip must offer Run, not Fix next.
 * Verified against the same referees the strip uses (schema.validateGraph,
 * compose.chainHealth/dataflowHealth, gaps.computeGaps): 0 must-fix,
 * 0 to-finish, two hints (landing URL, oracles) — hints never block a run.
 */
const graph = (id: string) => ({
  schema: 'process-graph/2', id, title: 'Tiny flow', tags: ['smoke'],
  systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
  actors: { a: 'sales_user' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 's1', type: 'session', label: 'SF · a', system: 'sf', actor: 'a', steps: { status: 'captured' } },
    { id: 'rec', type: 'data', label: 'Record', sobject: 'Account' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'l1', from: 'start', to: 's1', type: 'login_as' },
    { id: 'd1', from: 's1', to: 'rec', type: 'does', data: { catalog: 'rec.create', io: 'produces' } },
    { id: 'n', from: 'rec', to: 'end', type: 'next' },
  ],
});

interface PlannerWindow {
  planner: { openFromLibrary(ref: string): boolean; get(): { id: string } };
  P2: { state: { runs: Record<string, unknown>; ref: string; library: { projects: unknown[] } }; net: { served(): boolean } };
}

const boot = async (page: import('@playwright/test').Page, url: string) => {
  await page.goto(url);
  await page.waitForFunction(() => !!(window as unknown as PlannerWindow).planner, undefined, { timeout: 30_000 });
};
/** Served: the library arrives over /__library after boot — wait for the project. */
const libraryLoaded = (page: import('@playwright/test').Page) =>
  page.waitForFunction(() => (window as unknown as PlannerWindow).P2.state.library.projects.length > 0, undefined, { timeout: 15_000 });

test.describe('served', () => {
  let child: ChildProcess;
  let base = '';
  let tmp = '';

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-run-'));
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify(PERSONAS, null, 2));
    fs.mkdirSync(path.join(tmp, 'projects', 'runp', 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'projects', 'runp', 'project.json'), JSON.stringify({ project: 'runp', team: 'harness' }));
    fs.writeFileSync(path.join(tmp, 'projects', 'runp', 'graphs', 'tiny_flow.graph.json'), JSON.stringify(graph('tiny_flow'), null, 2));
    fs.mkdirSync(path.join(tmp, 'test-results'), { recursive: true });
    // The stub run: one annotated pass (our slug), one fail with an error.
    fs.writeFileSync(path.join(tmp, 'fake-run.mjs'),
      "import fs from 'node:fs'; import path from 'node:path';\n" +
      `const tr = ${JSON.stringify(path.join(tmp, 'test-results'))};\n` +
      "const video = path.join(tr, 'v.webm'); fs.writeFileSync(video, Buffer.alloc(16));\n" +
      "const ann = (ref) => [{ type: 'guide', description: JSON.stringify({ objective: ref.replace('/', '--') + '--default', title: ref, category: 'runp', journeyRef: ref }) }];\n" +
      "const res = (status) => [{ status, duration: 5, startTime: new Date().toISOString(), steps: [], attachments: [{ name: 'video', contentType: 'video/webm', path: video }], ...(status === 'failed' ? { error: { message: 'Lead was not created' }, errors: [{ message: 'Lead was not created' }] } : {}) }];\n" +
      "fs.writeFileSync(path.join(tr, 'results.json'), JSON.stringify({ suites: [{ title: 'e2e/graphs.spec.ts', file: 'e2e/graphs.spec.ts', specs: [\n" +
      "  { title: 'runp/tiny_flow', file: 'e2e/graphs.spec.ts', tests: [{ annotations: ann('runp/tiny_flow'), results: res('passed') }] },\n" +
      "  { title: 'runp/other', file: 'e2e/graphs.spec.ts', tests: [{ annotations: ann('runp/other'), results: res('failed') }] } ] }] }));\n");
    child = spawn('node', [path.resolve(ROOT, 'tools/serve-planner.mjs')], {
      env: {
        ...process.env, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1',
        PLANNER_RUN_CMD: `node ${path.join(tmp, 'fake-run.mjs')}`,
        PLANNER_TEST_RESULTS: path.join(tmp, 'test-results'),
      },
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

  test('Run this graph runs it, opens the review tab on the same site, and the strip shows a pill per test', async ({ page, context }) => {
    await boot(page, `${base}/`);
    await libraryLoaded(page);
    expect(await page.evaluate(() => (window as unknown as PlannerWindow).planner.openFromLibrary('runp/tiny_flow'))).toBe(true);
    await expect(page.locator('#strip #b_run1')).toHaveText('Run this graph');
    await expect(page.locator('#strip #b_runcmd')).toHaveCount(1); // the CI line is still one click away
    await expect(page.locator('#strip #f_openreview')).toBeChecked(); // open the review tab when done — default on

    // the tab opens AT THE CLICK (that is what popup blockers permit) …
    const [tab] = await Promise.all([context.waitForEvent('page'), page.locator('#b_run1').click()]);
    await expect(tab.locator('body')).toContainText('running graph:runp/tiny_flow');
    await expect(page.locator('#strip .chip.run')).toContainText(/running|ingesting/);
    await expect(page.locator('#strip #b_run1')).toBeDisabled();

    const pill = page.locator('#strip a.chip.review', { hasText: 'runp/tiny_flow' });
    await expect(pill).toBeVisible({ timeout: 30_000 });
    await expect(pill).toHaveClass(/ok/);
    await expect(pill).toHaveAttribute('target', '_blank');
    await expect(pill).toHaveAttribute('rel', 'noopener');
    const href = await pill.getAttribute('href');
    expect(href).toMatch(/^\/studio\/studio\.html\?batch=run-\d{8}-\d{6}-graph-runp-tiny_flow&slug=runp--tiny_flow--default$/);

    // … and lands on the review — served by THIS server, one reviewable test → its page
    await expect.poll(() => tab.url(), { timeout: 15_000 }).toBe(`${base}${href}`);
    await expect(tab.locator('body')).toContainText(/step|guide|narrat/i);
    // the pill and the "open review" link agree
    await expect(page.locator('#strip a.chip.review-open')).toHaveAttribute('href', href!);
    await tab.close();

    // the failing test: a red pill, no page (Journey Studio only builds pages for passes today), the error in the title
    const bad = page.locator('#strip .chip.bad', { hasText: 'runp/other' });
    await expect(bad).toBeVisible();
    await expect(bad).toHaveAttribute('title', /Lead was not created/);

    const dash = page.locator('#strip a.chip', { hasText: 'dashboard' });
    await expect(dash).toHaveAttribute('href', /^\/studio\/dashboard\.html\?batch=run-\d{8}-\d{6}-graph-runp-tiny_flow$/);
    await expect(page.locator('#strip #b_run1')).toBeEnabled();

    // toggle off → Run opens no tab
    await page.locator('#strip #f_openreview').uncheck();
    let popped = false;
    context.once('page', () => { popped = true; });
    await page.locator('#b_run1').click();
    await expect(page.locator('#strip #b_run1')).toBeEnabled({ timeout: 30_000 });
    expect(popped).toBe(false);

    // a reload keeps the links: /__runs fed state.runs from studio/runs.json
    await page.reload();
    await page.waitForFunction(() => !!(window as unknown as PlannerWindow).planner);
    await libraryLoaded(page);
    await page.evaluate(() => { (window as unknown as PlannerWindow).planner.openFromLibrary('runp/tiny_flow'); });
    await expect(page.locator('#strip a.chip.review', { hasText: 'runp/tiny_flow' })).toHaveAttribute('href', href!, { timeout: 15_000 });
  });
});

test.describe('file://', () => {
  test('Run this graph only copies the command — no server, no run', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
    await boot(page, PLANNER);
    const served = await page.evaluate(() => (window as unknown as PlannerWindow).P2.net.served());
    expect(served).toBe(false);
    // any built-in graph that is complete
    const opened = await page.evaluate(() => {
      const w = window as unknown as PlannerWindow;
      return w.planner.openFromLibrary('lead_to_customer');
    });
    expect(opened).toBe(true);
    const run = page.locator('#strip #b_run1');
    if (await run.count()) {
      await expect(page.locator('#strip #b_runcmd')).toHaveCount(0);
      await run.click();
      await expect(page.locator('#toast')).toContainText('copied');
      const runs = await page.evaluate(() => Object.keys((window as unknown as PlannerWindow).P2.state.runs));
      expect(runs).toEqual([]);
    }
  });
});
