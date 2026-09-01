/**
 * Projects in the planner (DESIGN-PROJECTS.md §3): the grouped toolbar, the
 * project selector, project-grouped/filtered graph library, and the
 * self-service "＋ new project…" flow — teams name their own projects,
 * nothing is hardcoded. file:// stays read-only with guidance; served mode
 * POSTs to the dev server (stubbed here; the real endpoint is covered by
 * serve-planner.spec).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const PLANNER = pathToFileURL(path.resolve('tools/process-planner.html')).href;

interface PlannerWindow {
  planner: {
    projects(): { list: string[]; current: string };
    setProject(p: string): void;
    export(): { json: string };
  };
  GRAPH_LIBRARY: Record<string, unknown>;
  PLANNER_FORCE_SERVED?: boolean;
  fetch: unknown;
}

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner, undefined, { timeout: 30_000 });
});

test('toolbar is grouped by workflow — every original control keeps its id, inside a labeled group', async ({ page }) => {
  const labels = await page.locator('header .tbg .tbl').allInnerTexts();
  expect(labels.map((l) => l.toLowerCase())).toEqual(['file', 'edit', 'view', 'test', 'project', 'mode']);
  for (const id of [
    'f_library', 'b_new', 'f_import', 'b_import', 'f_save', 'b_export', 'b_download',
    'b_add', 'b_connect', 'b_delete', 'b_graphmeta',
    'b_layout', 'b_fit', 'b_help',
    'b_check', 'f_test',
    'f_project', 'f_mode',
  ]) {
    await expect(page.locator(`header .tbg #${id}`), `#${id} should live inside a toolbar group`).toHaveCount(1);
  }
});

test('project selector: all-projects default plus the create option; debug surface agrees', async ({ page }) => {
  const options = await page.locator('#f_project option').allInnerTexts();
  expect(options[0]).toBe('all projects');
  expect(options[options.length - 1]).toContain('new project…');
  const state = await page.evaluate(() => (window as unknown as PlannerWindow).planner.projects());
  expect(state.current).toBe('');
});

test('library groups by project and the selector filters it', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as PlannerWindow;
    w.GRAPH_LIBRARY = {
      legacy_flow: { id: 'legacy_flow' },
      'web/checkout': { id: 'checkout' },
      'siebel/sync': { id: 'sync' },
    };
    w.planner.setProject(''); // rebuilds the library dropdown
  });
  let groups = await page.locator('#f_library optgroup').evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
  expect(groups).toEqual(['built-in (repo)', 'project · siebel', 'project · web']);
  // Project options are labeled by bare id but carry the full ref value.
  await expect(page.locator('#f_library option[value="lib:web/checkout"]')).toHaveText('checkout');

  await page.evaluate(() => { (window as unknown as PlannerWindow).planner.setProject('web'); });
  groups = await page.locator('#f_library optgroup').evaluateAll((els) => els.map((e) => (e as HTMLOptGroupElement).label));
  expect(groups).toEqual(['project · web']);
  expect(await page.evaluate(() => (window as unknown as PlannerWindow).planner.projects().current)).toBe('web');
});

test('file:// cannot create projects — the flow says how, and the selector snaps back', async ({ page }) => {
  await page.selectOption('#f_project', '__new');
  await expect(page.locator('#status')).toContainText('needs the dev server');
  await expect(page.locator('#f_project')).toHaveValue('');
});

test('served mode: name it once and the project exists — selector adopts it, status confirms', async ({ page }) => {
  page.on('dialog', (d) => { void d.accept('o2_provisioning'); });
  await page.evaluate(() => {
    const w = window as unknown as PlannerWindow;
    w.PLANNER_FORCE_SERVED = true;
    w.fetch = (url: string, init?: { method?: string }) => {
      if (url.includes('/__projects') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            project: { project: 'o2_provisioning' },
            projects: [{ project: 'o2_provisioning', graphs: 0 }],
          }),
        });
      }
      return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
    };
  });
  await page.selectOption('#f_project', '__new');
  await expect(page.locator('#status')).toContainText('project "o2_provisioning" created');
  const state = await page.evaluate(() => (window as unknown as PlannerWindow).planner.projects());
  expect(state.current).toBe('o2_provisioning');
  expect(state.list).toContain('o2_provisioning');
});

test('served refusal surfaces the server reason and keeps the selector honest', async ({ page }) => {
  page.on('dialog', (d) => { void d.accept('Bad Name'); });
  await page.evaluate(() => {
    const w = window as unknown as PlannerWindow;
    w.PLANNER_FORCE_SERVED = true;
    w.fetch = () => Promise.resolve({
      ok: false,
      json: () => Promise.resolve({ ok: false, error: "'Bad Name' — lower-case letters, digits, _ or - only (start with a letter)" }),
    });
  });
  await page.selectOption('#f_project', '__new');
  await expect(page.locator('#status')).toContainText('project NOT created');
  await expect(page.locator('#status')).toContainText('lower-case letters');
  await expect(page.locator('#f_project')).toHaveValue('');
});
