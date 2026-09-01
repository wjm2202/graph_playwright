/**
 * insert ▾ — compose another graph into the one on the canvas. The planner
 * runs the SAME composeGraphs the CLI uses (inlined at build); this drives
 * the UI path: pick from the library, splice after the selected session,
 * loud refusals in the status bar.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const PLANNER = pathToFileURL(path.resolve('tools/process-planner.html')).href;

interface ComposeWindow {
  planner: {
    load(g: unknown): { ok: boolean };
    select(id: string): void;
    insertGraph(value: string): { ok: boolean; summary?: string[]; errors?: string[] };
    get(): { nodes: { id: string; type: string }[]; edges: { id: string; type: string }[] };
  };
  GRAPH_LIBRARY: Record<string, unknown>;
}

const SF = { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' };
const HOST = {
  schema: 'process-graph/2', id: 'create_customer', systems: { sf: SF }, actors: { admin: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_sf_admin', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
    { id: 'customer', type: 'data', label: 'Customer' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'e1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 'e2', from: 'sess_sf_admin', to: 'customer', type: 'does', label: 'create customer', data: { catalog: 'cust.create' } },
    { id: 'e3', from: 'customer', to: 'end', type: 'next' },
  ],
};
const SUB = {
  schema: 'process-graph/2', id: 'add_address', systems: { sf: SF }, actors: { admin: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_sf_admin', type: 'session', label: 'SF · admin', system: 'sf', actor: 'admin' },
    { id: 'address', type: 'data', label: 'Address' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 's1', from: 'start', to: 'sess_sf_admin', type: 'login_as', data: { auth: 'frontdoor' } },
    { id: 's2', from: 'sess_sf_admin', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } },
    { id: 's3', from: 'address', to: 'end', type: 'next' },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner, undefined, { timeout: 30_000 });
  await page.evaluate(([host, sub]) => {
    const w = window as unknown as ComposeWindow;
    w.GRAPH_LIBRARY = { add_address: sub };
    w.planner.load(host);
  }, [HOST, SUB]);
});

test('insert lands an ISLAND: nothing auto-wired, status says what to draw, check ✓ referees', async ({ page }) => {
  const r = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('lib:add_address'));
  expect(r.ok).toBe(true);

  const g = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  expect(g.nodes.filter((n) => n.type === 'session').length).toBe(2); // NOT merged
  expect(g.nodes.find((n) => n.id === 'address')).toBeTruthy();
  expect(g.nodes.filter((n) => n.type === 'end').length).toBe(1);
  await expect(page.locator('#status')).toContainText('inserted "add_address"');
  await expect(page.locator('#status')).toContainText('UNWIRED');

  // The referee lists the arrival until the human wires it in.
  const issues = await page.evaluate(() => (window as unknown as { planner: { issues(): { gaps: { kind: string; at: string }[] } } }).planner.issues());
  expect(issues.gaps.some((x) => x.kind === 'session_off_chain' && x.at === 'add_address_sess_sf_admin')).toBe(true);
});

// Owner 2026-09-02: "when we import a graph it should already be selected
// for dragging with the rubber band — more often than not we will be moving
// it around the canvas."
test('the island arrives laid out to the RIGHT of the host, selected as a group with the drag frame up', async ({ page }) => {
  type W = ComposeWindow & {
    planner: { selection(): { nodes: string[]; edges: string[] }; groupBox(): { visible: boolean; count: string }; layout(): void };
    cy: { $id(id: string): { position(): { x: number; y: number } } };
  };
  // Host gets real positions first (a laid-out graph the human has arranged).
  await page.evaluate(() => { (window as unknown as W).planner.layout(); });
  const hostBefore = await page.evaluate(() => {
    const w = window as unknown as W;
    const r = (p: { x: number; y: number }) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    return ['start', 'sess_sf_admin', 'customer', 'end'].map((id) => [id, r(w.cy.$id(id).position())] as const);
  });

  const r = await page.evaluate(() => (window as unknown as W).planner.insertGraph('lib:add_address')) as { ok: boolean; arrived?: string[] };
  expect(r.ok).toBe(true);
  expect(r.arrived!.sort()).toEqual(['add_address_sess_sf_admin', 'address']); // merged/dropped nodes are not "arrivals"

  // Selected as a group — nodes AND the edge between them — frame visible.
  const sel = await page.evaluate(() => (window as unknown as W).planner.selection());
  expect(sel.nodes.sort()).toEqual(['add_address_sess_sf_admin', 'address']);
  expect(sel.edges).toEqual(['s2']);
  const box = await page.evaluate(() => (window as unknown as W).planner.groupBox());
  expect(box.visible).toBe(true);
  expect(box.count).toBe('2 nodes · 1 edges');
  await expect(page.locator('#status')).toContainText('2 nodes selected: drag the frame to place them');
  await expect(page.locator('#p_node')).toBeHidden(); // a group, never a card

  // Host untouched; island entirely to the right of it.
  const after = await page.evaluate(() => {
    const w = window as unknown as W;
    const pos = (id: string) => { const p = w.cy.$id(id).position(); return { x: Math.round(p.x), y: Math.round(p.y) }; };
    return {
      host: ['start', 'sess_sf_admin', 'customer', 'end'].map((id) => [id, pos(id)] as const),
      island: ['add_address_sess_sf_admin', 'address'].map((id) => [id, pos(id)] as const),
    };
  });
  expect(after.host).toEqual(hostBefore); // positions are rounded on sync — host layout untouched
  const hostRight = Math.max(...hostBefore.map(([, p]) => p.x));
  for (const [, p] of after.island) expect(p.x).toBeGreaterThan(hostRight + 100);
  // …and laid out, not stacked.
  expect(after.island[0]![1].x).not.toBe(after.island[1]![1].x);
});

test('a selected session changes nothing — insert NEVER auto-wires', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as ComposeWindow).planner.select('sess_sf_admin'); });
  const r = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('lib:add_address'));
  expect(r.ok).toBe(true);
  await expect(page.locator('#status')).toContainText('UNWIRED');
  const g = await page.evaluate(() => (window as unknown as ComposeWindow).planner.get());
  expect(g.edges.filter((e) => e.type === 'login_as').length).toBe(1); // only the host's original
});

test('refusals surface in the status bar — unknown ref, and composing a graph into itself', async ({ page }) => {
  const missing = await page.evaluate(() => (window as unknown as ComposeWindow).planner.insertGraph('lib:ghost'));
  expect(missing.ok).toBe(false);
  await expect(page.locator('#status')).toContainText('not in the library');

  // A library entry whose graph id matches the canvas graph — self-insert.
  const self = await page.evaluate((host) => {
    const w = window as unknown as ComposeWindow;
    w.GRAPH_LIBRARY = { create_customer_v2: host };
    (host as { id: string }).id = 'create_customer'; // same id as the canvas graph
    return w.planner.insertGraph('lib:create_customer_v2');
  }, JSON.parse(JSON.stringify(HOST)) as unknown as Record<string, unknown>);
  expect(self.ok).toBe(false);
  await expect(page.locator('#status')).toContainText('insert refused');
});
