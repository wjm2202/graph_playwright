/**
 * Group selection + group drag: plain drag stays pan/zoom navigation
 * (owner-corrected); SPACE + drag rubber-bands nodes AND edges. Two-plus
 * selected nodes grow a dashed bounding box whose grip/edges drag the whole
 * group; cards stay a single-select affair; Del clears the lot.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';

const PLANNER = pathToFileURL(path.resolve('tools/process-planner.html')).href;

interface GroupWindow {
  planner: {
    load(g: unknown): { ok: boolean };
    select(id: string): void;
    selectMany(ids: string[]): void;
    selection(): { nodes: string[]; edges: string[] };
    groupBox(): { visible: boolean; count: string };
    get(): { nodes: { id: string }[]; edges: { id: string }[] };
    undo(): boolean;
    undoDepth(): number;
    insertGraph(value: string): { ok: boolean };
  };
  cy: {
    $id(id: string): { position(): { x: number; y: number }; renderedBoundingBox(): { x1: number; y1: number; x2: number; y2: number } };
    userPanningEnabled(): boolean;
    boxSelectionEnabled(): boolean;
    zoom(): number;
  };
}

const SF = { label: 'SF', kind: 'salesforce' };
const GRAPH = {
  schema: 'process-graph/2', id: 'group_fixture', systems: { sf: SF }, actors: { a: 'admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 'sess_a', type: 'session', label: 'SF · a', system: 'sf', actor: 'a' },
    { id: 'rec_one', type: 'data', label: 'Record one' },
    { id: 'rec_two', type: 'data', label: 'Record two' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'l1', from: 'start', to: 'sess_a', type: 'login_as' },
    { id: 'd1', from: 'sess_a', to: 'rec_one', type: 'does', label: 'one', data: { catalog: 'rec.one' } },
    { id: 'd2', from: 'sess_a', to: 'rec_two', type: 'does', label: 'two', data: { catalog: 'rec.two' } },
    { id: 'j1', from: 'rec_one', to: 'rec_two', type: 'next' },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as { planner?: unknown }).planner, undefined, { timeout: 30_000 });
  await page.evaluate((g) => { (window as unknown as GroupWindow).planner.load(g); }, GRAPH as unknown as Record<string, unknown>);
});

test('plain drag ALWAYS pans; space+drag is the selection gesture (edit mode only)', async ({ page }) => {
  const flags = () => page.evaluate(() => {
    const win = window as unknown as GroupWindow;
    return { box: win.cy.boxSelectionEnabled(), pan: win.cy.userPanningEnabled() };
  });
  // Navigation is the default gesture — owner correction.
  expect(await flags()).toEqual({ box: false, pan: true });

  await page.keyboard.down('Space');
  expect(await flags()).toEqual({ box: true, pan: false });
  await page.keyboard.up('Space');
  expect(await flags()).toEqual({ box: false, pan: true });

  // View mode: space does nothing — pure navigation.
  await page.selectOption('#f_mode', 'view');
  await page.keyboard.down('Space');
  expect(await flags()).toEqual({ box: false, pan: true });
  await page.keyboard.up('Space');
  await page.selectOption('#f_mode', 'edit');
  expect(await flags()).toEqual({ box: false, pan: true });
});

test('a background drag selects the group — nodes AND the edge between them — and the box appears', async ({ page }) => {
  const zone = await page.evaluate(() => {
    const win = window as unknown as GroupWindow;
    const cyRect = document.getElementById('cy')!.getBoundingClientRect();
    const a = win.cy.$id('rec_one').renderedBoundingBox();
    const b = win.cy.$id('rec_two').renderedBoundingBox();
    return {
      x1: cyRect.left + Math.min(a.x1, b.x1) - 30, y1: cyRect.top + Math.min(a.y1, b.y1) - 30,
      x2: cyRect.left + Math.max(a.x2, b.x2) + 30, y2: cyRect.top + Math.max(a.y2, b.y2) + 30,
    };
  });
  await page.keyboard.down('Space'); // space + drag = rubber band
  await page.mouse.move(zone.x1, zone.y1);
  await page.mouse.down();
  await page.mouse.move(zone.x2, zone.y2, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');

  const sel = await page.evaluate(() => (window as unknown as GroupWindow).planner.selection());
  expect(sel.nodes).toEqual(expect.arrayContaining(['rec_one', 'rec_two']));
  expect(sel.edges).toContain('j1');

  const box = await page.evaluate(() => (window as unknown as GroupWindow).planner.groupBox());
  expect(box.visible).toBe(true);
  expect(box.count).toContain('nodes');
  await expect(page.locator('#status')).toContainText('drag the frame to move');

  // The PAGE never scrolls — a drag near the edge must not push the toolbar
  // off-screen (the 2026-09-01 lost-toolbar bug).
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('header .tbl').first()).toBeInViewport();
});

test('a selection hugging the top edge keeps the grip reachable and the toolbar in place', async ({ page }) => {
  await page.evaluate(() => {
    const win = window as unknown as {
      cy: {
        zoom(): number;
        pan(): { x: number; y: number };
        $id(id: string): { position(p: { x: number; y: number }): void };
      };
      planner: GroupWindow['planner'];
    };
    // Place the pair so their RENDERED top hugs the canvas top edge —
    // rendered = model*zoom + pan, so invert with the live transform.
    const z = win.cy.zoom();
    const p = win.cy.pan();
    const modelY = (24 - p.y) / z;
    win.cy.$id('rec_one').position({ x: (120 - p.x) / z, y: modelY });
    win.cy.$id('rec_two').position({ x: (320 - p.x) / z, y: modelY });
    win.planner.selectMany(['rec_one', 'rec_two']);
  });
  await page.evaluate(() => (window as unknown as GroupWindow).planner.groupBox()); // sync placement
  const gripTop = await page.locator('#gb_grip').evaluate((el) => (el as HTMLElement).style.top);
  expect(gripTop).toBe('4px'); // tucked inside the frame instead of under the toolbar
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.locator('header .tbl').first()).toBeInViewport();
});

test('dragging the grip moves every selected node by the same delta; unselected nodes stay put', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.selectMany(['rec_one', 'rec_two']); });
  const before = await page.evaluate(() => {
    const win = window as unknown as GroupWindow;
    return {
      one: win.cy.$id('rec_one').position(), two: win.cy.$id('rec_two').position(),
      sess: win.cy.$id('sess_a').position(), zoom: win.cy.zoom(),
    };
  });

  const grip = page.locator('#gb_grip');
  await expect(grip).toBeVisible();
  const gb = await grip.boundingBox();
  await page.mouse.move(gb!.x + gb!.width / 2, gb!.y + gb!.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb!.x + gb!.width / 2 + 80, gb!.y + gb!.height / 2 + 40, { steps: 5 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const win = window as unknown as GroupWindow;
    return {
      one: win.cy.$id('rec_one').position(), two: win.cy.$id('rec_two').position(),
      sess: win.cy.$id('sess_a').position(),
    };
  });
  const dx1 = after.one.x - before.one.x;
  const dy1 = after.one.y - before.one.y;
  expect(dx1).toBeCloseTo(80 / before.zoom, 0);
  expect(dy1).toBeCloseTo(40 / before.zoom, 0);
  expect(after.two.x - before.two.x).toBeCloseTo(dx1, 1); // the group moves as one
  expect(after.two.y - before.two.y).toBeCloseTo(dy1, 1);
  expect(after.sess).toEqual(before.sess); // bystanders untouched
  await expect(page.locator('#status')).toContainText('moved 2 nodes together');
});

test('cards are single-select only: one node → card; group → box, no card', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.select('rec_one'); });
  await expect(page.locator('#p_node')).toBeVisible();

  await page.evaluate(() => { (window as unknown as GroupWindow).planner.selectMany(['rec_one', 'rec_two']); });
  await expect(page.locator('#p_node')).toBeHidden();
  expect((await page.evaluate(() => (window as unknown as GroupWindow).planner.groupBox())).visible).toBe(true);

  await page.evaluate(() => { (window as unknown as GroupWindow).planner.select('rec_one'); });
  await expect(page.locator('#p_node')).toBeVisible();
  expect((await page.evaluate(() => (window as unknown as GroupWindow).planner.groupBox())).visible).toBe(false);
});

test('Del removes the whole selection — nodes, their edges, and selected edges', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.selectMany(['rec_one', 'rec_two']); });
  await page.keyboard.press('Delete');

  const g = await page.evaluate(() => (window as unknown as GroupWindow).planner.get());
  expect(g.nodes.map((n) => n.id)).toEqual(['start', 'sess_a', 'end']);
  expect(g.edges.map((e) => e.id)).toEqual(['l1']); // d1/d2/j1 went with their nodes
  await expect(page.locator('#status')).toContainText('deleted 2 node(s)');
});

// Owner report 2026-09-02: "I deleted the end node and half the graph
// disappeared." A click-selected node (its card open) is deleted ALONE —
// nothing else rides along — the status says exactly what went, and every
// delete is undoable (⌘Z / the undo button).
test('a single-node delete removes exactly that node + its edges, after a group selection has been and gone', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.selectMany(['rec_one', 'rec_two', 'sess_a']); }); // an earlier rubber-band…
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.select('end'); });                                // …then a plain click on ONE node
  expect(await page.evaluate(() => (window as unknown as GroupWindow).planner.selection().nodes)).toEqual(['end']);
  await page.keyboard.press('Delete');
  let g = await page.evaluate(() => (window as unknown as GroupWindow).planner.get());
  expect(g.nodes.map((n) => n.id)).toEqual(['start', 'sess_a', 'rec_one', 'rec_two']);
  await expect(page.locator('#status')).toContainText('deleted end');
  await expect(page.locator('#status')).toContainText('undo: ⌘Z');

  // ⌘Z brings it back, edges included.
  await page.keyboard.press('Meta+z');
  g = await page.evaluate(() => (window as unknown as GroupWindow).planner.get());
  expect(g.nodes.map((n) => n.id)).toEqual(['start', 'sess_a', 'rec_one', 'rec_two', 'end']);
  await expect(page.locator('#status')).toContainText('undid: delete node end');
  await expect(page.locator('#b_undo')).toBeDisabled();
});

test('a group delete is undoable too, and the status names what went', async ({ page }) => {
  await page.evaluate(() => { (window as unknown as GroupWindow).planner.selectMany(['rec_one', 'rec_two']); });
  await page.locator('#b_delete').click();
  await expect(page.locator('#status')).toContainText('deleted 2 node(s) [rec_one, rec_two]');
  expect(await page.evaluate(() => (window as unknown as GroupWindow).planner.get().nodes.length)).toBe(3);
  await page.locator('#b_undo').click();
  expect(await page.evaluate(() => (window as unknown as GroupWindow).planner.get().nodes.length)).toBe(5);
  expect(await page.evaluate(() => (window as unknown as GroupWindow).planner.get().edges.map((e) => e.id))).toEqual(['l1', 'd1', 'd2', 'j1']);
});
