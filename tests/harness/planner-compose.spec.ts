/**
 * S3.4 — the v2 port of `tests/harness/planner-compose.spec.ts`.
 *
 * v1's `insert ▾` landed the other graph as an ISLAND and left the human to
 * draw the seams; the review's answer (parity §1 `f_insert`) is that the
 * composer SPLICES — sessions merge on system+role, records merge by name,
 * `after` is inferred — and only falls back to an island when the merge is
 * refused, with the refusal naming the fix. So the assertions here are the
 * opposite of the old ones by design, and the rows the old spec pinned are
 * kept as: the graph the composer produced is still valid, the arrival is
 * reachable on the login chain, and both refusals still say why.
 *
 * The SHEET that drives this (Join another graph…) is covered by
 * planner-sheets.spec.ts; this spec drives `window.planner.insertGraph`,
 * which is the API name parity §8 keeps.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/planner.html')).href;

interface Doc {
  id: string;
  nodes: { id: string; type: string; label?: string; actor?: string; system?: string }[];
  edges: { id: string; from: string; to: string; type: string; label?: string }[];
  composedFrom?: { ref: string; graphId: string }[];
}
interface ComposeWindow {
  planner: {
    load(g: unknown): { ok: boolean; errors: string[] };
    get(): Doc;
    validate(): { ok: boolean; errors: string[] };
    insertGraph(ref: string, opts?: unknown): { ok: boolean; summary?: string[]; errors?: string[] };
    issues(): { errors: string[]; gaps: { kind: string; at: string }[] };
    runOrder(): { chain: string[]; steps: { edgeId: string }[]; problem?: string };
    undoDepth(): number;
    undo(): { ok: boolean };
  };
  GRAPH_LIBRARY: Record<string, unknown>;
  P2: { state: { doc: Doc }; net: { refreshLibrary?: unknown } };
}

const SF = { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' };
const HOST = {
  schema: 'process-graph/2', id: 'create_customer', systems: { sf: SF }, actors: { admin: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_sf_admin', type: 'session', label: 'Salesforce UAT · admin', system: 'sf', actor: 'admin' },
    { id: 'customer', type: 'data', label: 'Customer' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'e2', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'create customer', data: { catalog: 'cust.create' } },
    { id: 'e3', from: 'sess_sf_admin', to: 'end', type: 'next' },
  ],
};
/** Same system, same role → the composer MERGES this session into the host's. */
const SUB = {
  schema: 'process-graph/2', id: 'add_address', systems: { sf: SF }, actors: { admin: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_sf_admin', type: 'session', label: 'Salesforce UAT · admin', system: 'sf', actor: 'admin' },
    { id: 'address', type: 'data', label: 'Address' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 's1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 's2', from: 'sess_sf_admin', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } },
    { id: 's3', from: 'sess_sf_admin', to: 'end', type: 'next' },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as ComposeWindow).planner, undefined, { timeout: 30_000 });
  await page.evaluate(([host, sub]) => {
    const w = window as unknown as ComposeWindow;
    w.GRAPH_LIBRARY = { add_address: sub };
    w.planner.load(host);
  }, [HOST, SUB] as [unknown, unknown]);
});

test('insert SPLICES after a session: the shared role stays one lane and the new step joins it', async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('add_address', { after: 'sess_sf_admin' }));
  expect(r.ok).toBe(true);

  const g = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  // v1 asserted TWO sessions (an island). v2 merges on system+role: one lane.
  expect(g.nodes.filter((n) => n.type === 'session').length).toBe(1);
  expect(g.nodes.find((n) => n.label === 'Address')).toBeTruthy();
  expect(g.nodes.filter((n) => n.type === 'end').length).toBe(1);
  expect(g.nodes.filter((n) => n.type === 'start').length).toBe(1);

  // Both steps now hang off the one lane, and the walker reaches them.
  const order = await page.evaluate(() => (window as unknown as ComposeWindow).planner.runOrder());
  expect(order.problem).toBeFalsy();
  expect(order.steps.length).toBe(2);
  expect(await page.evaluate(() => (window as unknown as ComposeWindow).planner.validate().ok)).toBe(true);
});

test('the spliced graph has NO stranded arrival — the seam the human used to draw is inferred', async ({ page }) => {
  await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('add_address', { after: 'sess_sf_admin' }));
  const issues = await page.evaluate(() => (window as unknown as ComposeWindow).planner.issues());
  // The row v1 pinned (`session_off_chain` on the arrival) must NOT be here:
  // that gap existed because insert refused to wire anything.
  expect(issues.gaps.some((x) => x.kind === 'session_off_chain')).toBe(false);
  expect(issues.errors.join()).not.toContain('not on the login chain');

  // Provenance is recorded, so a stale copy is detectable later.
  const doc = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  expect((doc.composedFrom ?? []).some((c) => c.graphId === 'add_address')).toBe(true);
});

/**
 * The v1 behaviour, kept as the FALLBACK the parity table promises: with no
 * `after` (the composer's island mode) nothing is auto-wired, and the arrival
 * is listed as off the chain until the human joins it — which is exactly what
 * `planner-compose.spec.ts` asserted, now one door down instead of the only
 * door.
 */
test('island mode still lands unwired, and the referee lists the arrival', async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('add_address', { mode: 'island' }));
  expect(r.ok).toBe(true);

  const g = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  expect(g.nodes.filter((n) => n.type === 'session').length).toBe(2);   // NOT merged
  expect(g.nodes.find((n) => n.label === 'Address')).toBeTruthy();
  expect(g.nodes.filter((n) => n.type === 'end').length).toBe(1);

  // v1 read this off the gap engine (`session_off_chain`); in v2 the login
  // chain is one of the three MUST-FIX referees, so it is an error, not a
  // question — the same fact, promoted.
  const issues = await page.evaluate(() => (window as unknown as ComposeWindow).planner.issues());
  expect(issues.errors.join()).toContain("session 'add_address_sess_sf_admin' is not on the login chain");
  expect(r.summary!.join('\n')).toContain('arrived UNWIRED');
});

test('an insert is one undoable edit — the document goes back exactly as it was', async ({ page }) => {
  const before = await page.evaluate(() => JSON.stringify((window as unknown as ComposeWindow).planner.get()));
  const depth = await page.evaluate(() => (window as unknown as ComposeWindow).planner.undoDepth());
  await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('add_address', { after: 'sess_sf_admin' }));
  expect(await page.evaluate(() => (window as unknown as ComposeWindow).planner.undoDepth())).toBe(depth + 1);

  await page.evaluate(() => (window as unknown as ComposeWindow).planner.undo());
  expect(await page.evaluate(() => JSON.stringify((window as unknown as ComposeWindow).planner.get()))).toBe(before);
});

test('refusals say why — an unknown ref, and composing a graph into itself', async ({ page }) => {
  const missing = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('ghost'));
  expect(missing.ok).toBe(false);
  expect((missing.errors ?? []).join()).toContain("unknown graph 'ghost'");

  const self = await page.evaluate((host) => {
    const w = window as unknown as ComposeWindow;
    (host as { id: string }).id = 'create_customer';       // the id already open
    w.GRAPH_LIBRARY = { create_customer_v2: host };
    return w.planner.insertGraph('create_customer_v2');
  }, JSON.parse(JSON.stringify(HOST)) as unknown as Record<string, unknown>);
  expect(self.ok).toBe(false);
  expect((self.errors ?? []).join()).toBeTruthy();

  // Nothing was written by either refusal.
  const g = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  expect(g.nodes.find((n) => n.label === 'Address')).toBeFalsy();
  expect(await page.evaluate(() => (window as unknown as ComposeWindow).planner.validate().ok)).toBe(true);
});
