/**
 * S3.4 — the v2 port of `tests/harness/planner-order-health.spec.ts`.
 *
 * The hand-wiring referee, in the new planner: chain health lands in the
 * CHECK STRIP the moment a seam is mis-wired (a branch is must-fix, a session
 * off the chain is must-fix with its own line), and the RUN ORDER is no
 * longer a dialog — the script's line numbers ARE the sequence the walker
 * executes (parity §3 `f_test → order`, disposition **automated**). Where the
 * old spec asserted `#runorder` / `#ro_list` / `#ro_close`, this one asserts
 * the numbered lines and `window.planner.runOrder()`, which is the same
 * information without a second surface to keep in step.
 *
 * The window type is LOCAL (never `declare global`): tests/harness/planner.spec.ts
 * declares `window.planner` with the v1 shape, and two global declarations of
 * one property do not merge.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/journey-planner.html')).href;

interface Doc {
  id: string;
  nodes: { id: string; type: string; label?: string }[];
  edges: { id: string; from: string; to: string; type: string }[];
}
interface HealthWindow {
  planner: {
    load(g: unknown): { ok: boolean; errors: string[] };
    get(): Doc;
    connect(from: string, to: string, type?: string): string | null;
    addTyped(type: string): string | null;
    issues(): { errors: string[]; gaps: { kind: string; at: string }[] };
    runOrder(): { steps: { name: string; actor: string; edgeId: string }[]; chain: string[]; problem?: string };
    select(id: string): void;
  };
  P2: {
    state: { doc: Doc; sel: { kind: string; id: string } };
    view: { checks(doc: Doc, o?: unknown): { mustFix: { text: string }[]; toFinish: { text: string }[] } };
  };
}

const SF = { label: 'SF', kind: 'salesforce' };
const GRAPH = {
  schema: 'process-graph/2', id: 'create_customer', systems: { sf: SF },
  actors: { admin: 'admin', approver: 'sales_user' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_a', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
    { id: 'sess_b', type: 'session', label: 'SF · approver', system: 'sf', actor: 'approver' },
    { id: 'customer', type: 'data', label: 'Customer' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'l1', from: 'start', to: 'sess_a', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'l2', from: 'sess_a', to: 'sess_b', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'd1', from: 'sess_a', to: 'customer', type: 'does', label: 'create customer', data: { catalog: 'cust.create' } },
    { id: 'd2', from: 'sess_b', to: 'customer', type: 'does', label: 'approve customer', data: { catalog: 'cust.approve' } },
    { id: 'n1', from: 'customer', to: 'end', type: 'next' },
  ],
};

/** The same graph with a session the login chain never reaches. */
const STRANDED = (() => {
  const g = JSON.parse(JSON.stringify(GRAPH)) as typeof GRAPH & { nodes: { id: string; type: string; label: string; system?: string; actor?: string }[] };
  g.nodes.push({ id: 'sess_orphan', type: 'session', label: 'SF · orphan', system: 'sf', actor: 'admin' });
  return g;
})();

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  // ~1.3 MB of inline script: under parallel worker load 30s is honest.
  await page.waitForFunction(() => !!(window as unknown as HealthWindow).planner, undefined, { timeout: 30_000 });
  await page.evaluate((g) => { (window as unknown as HealthWindow).planner.load(g); }, GRAPH as unknown as Record<string, unknown>);
});

test('a mis-wired chain is must-fix in the check strip the moment it is drawn', async ({ page }) => {
  let issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  expect(issues.errors.join()).not.toContain('login_as');
  await expect(page.locator('#strip .chip').first()).toContainText('0 must fix');

  // The human draws a SECOND login_as out of sess_a — a branch.
  const extra = await page.evaluate(() => {
    const w = window as unknown as HealthWindow;
    const id = w.planner.addTyped('session')!;
    // addTyped('session') CHAINS the new lane (v2 keeps the chain linear), so
    // the branch has to be drawn deliberately, exactly as a drag would.
    w.planner.connect('sess_a', id, 'login_as');
    return id;
  });
  expect(extra).toBeTruthy();

  issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  expect(issues.errors.join()).toContain("'sess_a' has");
  expect(issues.errors.join()).toContain('outgoing login_as edges');

  // The strip is the v1 `check (n)` badge and the issues panel, in one row.
  const strip = page.locator('#strip .chip').first();
  await expect(strip).not.toContainText('0 must fix');
  await expect(strip).toHaveClass(/bad/);
});

test('a session off the login chain is must-fix, and its line says so', async ({ page }) => {
  await page.evaluate((g) => { (window as unknown as HealthWindow).planner.load(g); }, STRANDED as unknown as Record<string, unknown>);

  const texts = await page.evaluate(() => {
    const w = window as unknown as HealthWindow;
    return w.P2.view.checks(w.P2.state.doc).mustFix.map((r) => r.text);
  });
  expect(texts.join('\n')).toContain("session 'sess_orphan' is not on the login chain");

  // …and the line wears it: the amber `stranded` class plus the pill v1 put
  // in the issues panel ("wire it into the chain with ↑ ↓, or delete it").
  await expect(page.locator('.line.session.stranded')).toHaveCount(1);
  await expect(page.locator('.line.session.stranded .pill.bad')).toHaveText('stranded');
});

test('the script line numbers ARE the run order, and clicking one selects its step', async ({ page }) => {
  const order = await page.evaluate(() => (window as unknown as HealthWindow).planner.runOrder());
  expect(order.problem).toBeFalsy();
  expect(order.steps.map((s) => s.edgeId)).toEqual(['d1', 'd2']);
  expect(order.steps.map((s) => s.actor)).toEqual(['admin', 'approver']);

  const nums = await page.locator('.line.step .num').allInnerTexts();
  expect(nums).toEqual(['1.1', '2.1']);
  const lines = page.locator('.line.step');
  await expect(lines.nth(0)).toContainText('cust.create');
  await expect(lines.nth(1)).toContainText('cust.approve');

  await lines.nth(1).click();
  expect(await page.evaluate(() => (window as unknown as HealthWindow).P2.state.sel)).toEqual({ kind: 'step', id: 'd2' });
});

test('an unwalkable graph shows the PROBLEM in the script pane, never a wrong order', async ({ page }) => {
  await page.evaluate(() => {
    (window as unknown as HealthWindow).planner.connect('sess_b', 'sess_a', 'login_as'); // cycle
  });
  const order = await page.evaluate(() => (window as unknown as HealthWindow).planner.runOrder());
  expect(order.problem).toContain('cycle');
  expect(order.steps).toEqual([]);

  // The pane prints the problem where the lines would be — the v1 dialog said
  // "see check ✓"; here the check strip is already on screen above it.
  await expect(page.locator('#scriptwrap .stub')).toContainText('cycle');
  const issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  expect(issues.errors.join()).toContain('cycle');
});
