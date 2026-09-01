/**
 * The hand-wiring referee in the planner: chain health lands in the check
 * panel the moment a seam is mis-wired (branch = red, stranded session =
 * amber), and ▶ test → run order… shows the exact sequence the wiring
 * produced — rows click-jump to their edge.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const PLANNER = pathToFileURL(path.resolve('tools/process-planner.html')).href;

interface HealthWindow {
  planner: {
    load(g: unknown): { ok: boolean };
    connect(from: string, to: string, type?: string): string;
    addTyped(type: string): string;
    issues(): { errors: string[]; gaps: { kind: string; at: string }[] };
    runOrder(): { steps: { name: string; actor: string; edgeId: string }[]; problem?: string };
  };
  cy: { $(sel: string): { id(): string; length: number } };
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

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner, undefined, { timeout: 30_000 });
  await page.evaluate((g) => { (window as unknown as HealthWindow).planner.load(g); }, GRAPH as unknown as Record<string, unknown>);
});

test('a mis-wired chain goes RED in the badge and check panel the moment it is drawn', async ({ page }) => {
  // Wired correctly → no chain complaints.
  let issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  expect(issues.errors.join()).not.toContain('login_as');

  // The human draws a SECOND login_as out of sess_a — a branch.
  await page.evaluate(() => {
    const w = window as unknown as HealthWindow;
    const extra = w.planner.addTyped('session');
    w.planner.connect('sess_a', extra, 'login_as');
  });
  issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  expect(issues.errors.join()).toContain("'sess_a' has 2 outgoing login_as edges");
  await expect(page.locator('#b_check')).toContainText('check (');
  await expect(page.locator('#b_check')).toHaveCSS('color', 'rgb(226, 96, 79)'); // red = must fix

  await page.locator('#b_check').click();
  await expect(page.locator('#iss_list')).toContainText('outgoing login_as');
});

test('an unwired session is stranded — amber, with the wire-or-delete hint', async ({ page }) => {
  const newId = await page.evaluate(() => (window as unknown as HealthWindow).planner.addTyped('session'));
  const issues = await page.evaluate(() => (window as unknown as HealthWindow).planner.issues());
  const stranded = issues.gaps.find((g) => g.kind === 'session_off_chain');
  expect(stranded?.at).toBe(newId);

  await page.locator('#b_check').click();
  await expect(page.locator('#iss_list')).toContainText('not on the login chain');
});

test('run order… shows the sequence the wiring produced; a row click selects its edge', async ({ page }) => {
  await page.selectOption('#f_test', 'order');
  await expect(page.locator('#runorder')).toBeVisible();
  const rows = page.locator('#ro_list .ro_row');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('1 · admin — create customer');
  await expect(rows.nth(0)).toContainText('cust.create');
  await expect(rows.nth(1)).toContainText('2 · approver — approve customer');

  await rows.nth(1).click();
  const selected = await page.evaluate(() => (window as unknown as HealthWindow).cy.$(':selected').id());
  expect(selected).toBe('d2');

  await page.locator('#ro_close').click();
  await expect(page.locator('#runorder')).toBeHidden();
});

test('an unwalkable graph previews the PROBLEM, never a wrong order', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as HealthWindow;
    w.planner.connect('sess_b', 'sess_a', 'login_as'); // cycle
  });
  await page.selectOption('#f_test', 'order');
  await expect(page.locator('#ro_list')).toContainText('cycle');
  await expect(page.locator('#ro_list')).toContainText('see check ✓');
});
