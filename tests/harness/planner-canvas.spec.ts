/**
 * S3.2 — the journey script planner's CANVAS, driven over file:// exactly as
 * a user double-clicking tools/planner.html would get it.
 *
 * Every row of docs/PLANNER-FEATURE-PARITY.md §6 is asserted here at least
 * once, because that table is the retirement gate for the old planner: a
 * gesture with no test is a gesture that quietly stopped working. The canvas
 * is a RENDERING — so each test checks the picture AND the document it came
 * from, and the ones that mutate check the graph is still valid afterwards.
 *
 * The window type is LOCAL (never `declare global`): each planner spec types
 * only the slice of `window.planner` it drives, and two global declarations
 * of one property do not merge.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { goodGraphV2 } from '../helpers/sampleGraph';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/planner.html')).href;

interface Pos { x: number; y: number }
interface BBox { x1: number; y1: number; x2: number; y2: number; w: number; h: number }
/** Cytoscape elements and collections share one interface, as they do at runtime. */
interface CyColl {
  length: number;
  id(): string;
  empty(): boolean;
  isParent(): boolean;
  hasClass(c: string): boolean;
  classes(): string[];
  data(k: string): unknown;
  position(): Pos;
  children(): CyColl;
  renderedBoundingBox(o?: unknown): BBox;
  map<T>(f: (el: CyColl) => T): T[];
}
interface Cy {
  nodes(sel?: string): CyColl;
  edges(sel?: string): CyColl;
  getElementById(id: string): CyColl;
  zoom(z?: number): number;
  pan(p?: Pos): Pos;
  boxSelectionEnabled(v?: boolean): boolean;
  emit(name: string): void;
}
interface OpResult { ok: boolean; errors: string[]; id?: string; kind?: string }
interface DocNode {
  id: string; type: string; label?: string; pos?: Pos;
  steps?: { status: string }; timing?: { capturedMeanMs?: number };
  expects?: { id: string; after?: string; lastResult?: { status: string; at: string } }[];
}
interface DocEdge { id: string; from: string; to: string; type: string; label?: string; data?: Record<string, unknown> }
interface Doc { schema: string; id: string; nodes: DocNode[]; edges: DocEdge[] }
interface CanvasApi {
  instance(): Cy;
  edgehandles(): unknown;
  isMounted(): boolean;
  nodes(): string[];
  edges(): string[];
  fit(): void;
  layout(): void;
  connectFrom(from: string, to: string | null, pos?: Pos): OpResult;
  dropChoice(kind: string): OpResult;
  closeDropChoice(): void;
  newSession(pos?: Pos): string | null;
  anchor(sel: { kind: string; id: string }): HTMLElement | null;
  groupBox(): { visible: boolean; count: string };
  selection(): { nodes: string[]; edges: string[] };
}
interface V2Window {
  planner: {
    get(): Doc;
    load(g: unknown): { ok: boolean; errors: string[] };
    validate(): { ok: boolean; errors: string[] };
    openFromLibrary(ref: string): boolean;
    connect(from: string, to: string, type?: string): string | null;
    selectMany(ids: string[]): void;
    selection(): { nodes: string[]; edges: string[] };
    groupBox(): { visible: boolean; count: string };
    tipFor(id: string): string;
  };
  P2: {
    state: { doc: Doc; sel: { kind: string; id: string }; cardOpen: boolean; recording: Record<string, unknown>; msel: string[] };
    canvas: CanvasApi;
    ops: Record<string, ((...args: never[]) => OpResult) | undefined>;
    ui: { render(): void; select(sel: { kind: string; id: string }, open?: boolean): void };
    view: { lines(doc: Doc): { sessions: { id: string; steps: { edgeId: string }[] }[]; records: { id: string; name: string }[] } };
    lib: { compose(): { runOrder(g: Doc): { chain: string[] } } };
  };
  GRAPH_LIBRARY: Record<string, Doc>;
}

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  // ~1.3 MB of inline script: under parallel worker load 30s is honest.
  await page.waitForFunction(() => !!(window as unknown as V2Window).planner, undefined, { timeout: 30_000 });
  await page.evaluate(() => { (window as unknown as V2Window).P2.canvas.fit(); });
});

/** The viewport-space centre of a drawn element, for real mouse gestures. */
async function centreOf(page: Page, id: string, dy = 0): Promise<Pos> {
  return page.evaluate(([elId, off]: [string, number]) => {
    const cy = (window as unknown as V2Window).P2.canvas.instance();
    const bb = cy.getElementById(elId).renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    const r = document.getElementById('cy')!.getBoundingClientRect();
    return { x: r.left + (bb.x1 + bb.x2) / 2, y: r.top + (off ? bb.y1 + off : (bb.y1 + bb.y2) / 2) };
  }, [id, dy] as [string, number]);
}

/**
 * A viewport point inside the stage that is BARE canvas: outside every drawn
 * element (so the tap reaches the core) and not under the node card.
 */
async function emptyPoint(page: Page): Promise<Pos> {
  return page.evaluate(() => {
    const cy = (window as unknown as V2Window).P2.canvas.instance();
    const r = document.getElementById('cy')!.getBoundingClientRect();
    const bb = cy.nodes().renderedBoundingBox({ includeLabels: true });
    const tries: [number, number][] = [];
    if (bb.x1 > 12) tries.push([bb.x1 / 2, r.height / 2]);
    if (r.width - bb.x2 > 12) tries.push([(bb.x2 + r.width) / 2, r.height / 2]);
    if (bb.y1 > 12) tries.push([r.width / 2, bb.y1 / 2]);
    if (r.height - bb.y2 > 12) tries.push([r.width / 2, (bb.y2 + r.height) / 2]);
    tries.push([4, r.height - 4], [r.width - 4, r.height - 4], [4, 4], [r.width - 4, 4]);
    for (const [x, y] of tries) {
      const at = document.elementFromPoint(r.left + x, r.top + y);
      const inside = x > 1 && y > 1 && x < r.width - 1 && y < r.height - 1;
      if (inside && at?.tagName === 'CANVAS') return { x: r.left + x, y: r.top + y };
    }
    return { x: r.left + 4, y: r.top + 4 };
  });
}

async function drag(page: Page, from: Pos, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(120);
}

// ---------------------------------------------------------------- rendering

test('every shipped graph draws one compound lane per session, in chain order', async ({ page }) => {
  const refs = await page.evaluate(() => Object.keys((window as unknown as V2Window).GRAPH_LIBRARY).sort());
  expect(refs.length).toBeGreaterThan(2);
  for (const ref of refs) {
    const out = await page.evaluate((r: string) => {
      const p = (window as unknown as V2Window);
      p.planner.openFromLibrary(r);
      const cy = p.P2.canvas.instance();
      const doc = p.planner.get();
      const lanes = cy.nodes('.lane');
      return {
        chain: p.P2.lib.compose().runOrder(doc).chain,
        // Lanes left→right IS the login chain: the grid lays runOrder out in x.
        byX: lanes.map((n) => ({ id: n.id(), x: n.renderedBoundingBox({ includeLabels: false }).x1 }))
          .sort((a, b) => a.x - b.x).map((n) => n.id),
        compound: lanes.map((n) => n.isParent()),
        stepNodes: cy.nodes('.step').map((n) => String(n.data('doc'))).sort(),
        stepEdges: doc.edges.filter((e) => ['does', 'denied', 'asserts'].includes(e.type)).map((e) => e.id).sort(),
        // One drawn node per RECORD, however many steps land on it.
        records: cy.nodes('.record').map((n) => n.id()).sort(),
        dataNodes: doc.nodes.filter((n) => n.type === 'data').map((n) => n.id).sort(),
      };
    }, ref);
    expect(out.byX, `${ref}: lanes in chain order`).toEqual(out.chain);
    expect(out.compound.every(Boolean), `${ref}: every lane is a compound parent`).toBe(true);
    // One step child per does / denied / asserts edge — no more, no fewer.
    expect(out.stepNodes, `${ref}: step children`).toEqual(out.stepEdges);
    expect(out.records, `${ref}: shared record nodes`).toEqual(out.dataNodes);
  }
});

test('a record two lanes both touch is ONE drawn node, wired to every step', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    return {
      records: cy.nodes('.record').map((n) => n.id()),
      into: cy.edges('.io').map((e) => `${String(e.data('source'))}→${String(e.data('target'))}`),
      ports: cy.edges('.io').map((e) => String(e.data('io'))),
      produces: cy.edges('.io.produces').length,
      updates: cy.edges('.io.updates').length,
      denied: cy.edges('.io.denied').length,
    };
  }, goodGraphV2());
  expect(out.records).toEqual(['expense']);
  // Four steps, four edges, all onto the one record.
  expect(out.into).toEqual([
    'step:e2→expense', 'step:e3→expense', 'step:e5→expense', 'step:e7→expense',
  ]);
  // Port colouring (parity: the edge label / port glyph moved onto the edge).
  expect(out.ports).toEqual(['produces', '', 'updates', 'consumes']);
  expect(out.produces).toBe(1);
  expect(out.updates).toBe(1);
  expect(out.denied).toBe(1);
});

test('the login chain is drawn lane→lane, and the thin relations stay thin', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    return {
      chain: cy.edges('.chain').map((e) => `${String(e.data('source'))}→${String(e.data('target'))}`),
      thin: cy.edges('.thin').map((e) => String(e.data('kind'))),
      terminals: cy.nodes('.terminal').map((n) => n.id()).sort(),
    };
  }, goodGraphV2());
  expect(out.chain).toEqual(['start→sess_sf_sales', 'sess_sf_sales→sess_sf_admin', 'sess_sf_admin→sess_siebel_admin']);
  expect(out.thin).toEqual(['next']);
  expect(out.terminals).toEqual(['end', 'start']);
});

// ------------------------------------------------------------- §6 drag/pos

test('parity §6 · dragging a record writes `pos`, and it survives a reload', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const before = await page.evaluate(() => (window as unknown as V2Window).planner.get().nodes.find((n) => n.id === 'expense')?.pos ?? null);
  expect(before).toBeNull();
  // Where the GRID put it — records hang under the lane that first touches
  // them (S3.4), so the assertion below is relative to the slot, never to a
  // hard-coded x that a layout change would invalidate.
  const slot = await page.evaluate(() => (window as unknown as V2Window).P2.canvas.instance().getElementById('expense').position());

  await drag(page, await centreOf(page, 'expense'), 70, 45);

  const after = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    const cy = p.P2.canvas.instance();
    const drawn = cy.getElementById('expense').position();
    const doc = p.planner.get();
    // Round-trip the document: the saved pos must put it back where it is.
    p.planner.load(doc);
    return { pos: doc.nodes.find((n) => n.id === 'expense')?.pos, drawn, reloaded: cy.getElementById('expense').position(), valid: p.planner.validate().ok };
  });
  expect(after.pos).toBeTruthy();
  expect(after.valid).toBe(true);
  expect(after.pos!.x).toBeGreaterThan(slot.x + 10);
  expect(after.pos!.y).toBeGreaterThan(slot.y + 5);
  expect(Math.abs(after.reloaded.x - after.drawn.x)).toBeLessThan(2);
  expect(Math.abs(after.reloaded.y - after.drawn.y)).toBeLessThan(2);
});

test('parity §6 · dragging a LANE moves its steps with it and round-trips too', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const step0 = await page.evaluate(() => (window as unknown as V2Window).P2.canvas.instance().getElementById('step:e5').position());

  // The lane's own body is the strip above its first step box (compound
  // padding) — grabbing a step child would grab the child, not the lane.
  await drag(page, await centreOf(page, 'sess_sf_admin', 4), 45, -35);

  const out = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    const cy = p.P2.canvas.instance();
    const doc = p.planner.get();
    // MODEL space, not rendered: opening a document re-fits the stage (S3.4),
    // so a rendered bounding box would be measuring the viewport, not the
    // round-trip this test is about.
    const drawn = cy.getElementById('step:e5').position();
    p.planner.load(doc);
    return {
      pos: doc.nodes.find((n) => n.id === 'sess_sf_admin')?.pos,
      step: drawn,
      reloaded: cy.getElementById('step:e5').position(),
      drawn,
      valid: p.planner.validate().ok,
    };
  });
  expect(out.pos).toBeTruthy();
  expect(out.valid).toBe(true);
  expect(out.step.x).not.toBe(step0.x);            // the children came along
  expect(Math.abs(out.reloaded.x - out.drawn.x)).toBeLessThan(2);
  expect(Math.abs(out.reloaded.y - out.drawn.y)).toBeLessThan(2);
});

test('auto layout forgets every saved `pos` and puts the lane grid back', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    p.P2.ops.setLayoutPos!('expense' as never, 900 as never, 900 as never);
    const moved = p.planner.get().nodes.find((n) => n.id === 'expense')?.pos;
    p.P2.canvas.layout();
    const doc = p.planner.get();
    return { moved, after: doc.nodes.filter((n) => n.pos).length, valid: p.planner.validate().ok };
  }, goodGraphV2());
  expect(out.moved).toEqual({ x: 900, y: 900 });
  expect(out.after).toBe(0);
  expect(out.valid).toBe(true);
});

// -------------------------------------------------- §6 drag-to-connect (eh)

test('parity §6 · edgehandles is registered on the canvas', async ({ page }) => {
  const out = await page.evaluate(() => {
    const cy = (window as unknown as V2Window).P2.canvas.instance() as unknown as Record<string, unknown>;
    return { eh: !!(window as unknown as V2Window).P2.canvas.edgehandles(), fn: typeof cy.edgehandles, mounted: (window as unknown as V2Window).P2.canvas.isMounted() };
  });
  expect(out).toEqual({ eh: true, fn: 'function', mounted: true });
});

test('parity §6 · a drop of a lane onto a record offers does / must not', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const res = p.P2.canvas.connectFrom('sess_siebel_admin', 'expense', { x: 40, y: 40 });
    const pop = document.getElementById('cy_drop')!;
    const shown = { open: !pop.classList.contains('hide'), buttons: Array.from(pop.querySelectorAll('[data-c]')).map((b) => (b as HTMLElement).dataset.c) };
    const chosen = p.P2.canvas.dropChoice('denied');
    const doc = p.planner.get();
    const edge = doc.edges.find((e) => e.id === chosen.id);
    return { res, shown, chosen, edge, valid: p.planner.validate().ok, sel: p.P2.state.sel, cardOpen: p.P2.state.cardOpen };
  }, goodGraphV2());
  expect(out.res.kind).toBe('choice');
  expect(out.shown.open).toBe(true);
  expect(out.shown.buttons).toEqual(['does', 'denied']);
  expect(out.chosen.ok).toBe(true);
  expect(out.edge?.type).toBe('denied');
  expect(out.edge?.from).toBe('sess_siebel_admin');
  expect(out.edge?.to).toBe('expense');
  expect(out.valid).toBe(true);
  // The new line's card opens, ready for the verb.
  expect(out.sel).toEqual({ kind: 'step', id: out.chosen.id });
  expect(out.cardOpen).toBe(true);
});

test('parity §6 · lane → lane re-chains the login order, and stays valid', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const before = p.P2.lib.compose().runOrder(p.planner.get()).chain;
    const res = p.P2.canvas.connectFrom('sess_sf_sales', 'sess_siebel_admin', { x: 0, y: 0 });
    const after = p.P2.lib.compose().runOrder(p.planner.get()).chain;
    return { before, res, after, valid: p.planner.validate(), drawn: p.P2.canvas.instance().nodes('.lane').length };
  }, goodGraphV2());
  expect(out.before).toEqual(['sess_sf_sales', 'sess_sf_admin', 'sess_siebel_admin']);
  expect(out.res.ok).toBe(true);
  expect(out.after).toEqual(['sess_sf_sales', 'sess_siebel_admin', 'sess_sf_admin']);
  expect(out.valid).toEqual({ ok: true, errors: [] });
  expect(out.drawn).toBe(3);
});

test('parity §6 · a lane dropped on empty canvas becomes the next session, there', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const res = p.P2.canvas.connectFrom('sess_sf_sales', null, { x: 640, y: 320 });
    const doc = p.planner.get();
    return {
      res,
      chain: p.P2.lib.compose().runOrder(doc).chain,
      pos: doc.nodes.find((n) => n.id === res.id)?.pos,
      valid: p.planner.validate().ok,
    };
  }, goodGraphV2());
  expect(out.res.ok).toBe(true);
  expect(out.chain[1]).toBe(out.res.id);
  expect(out.pos?.x).toBe(640);
  expect(out.valid).toBe(true);
});

test('a connect the relation table refuses says why, and changes nothing', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const edges = p.planner.get().edges.length;
    const res = p.P2.canvas.connectFrom('expense', 'sess_sf_admin', { x: 0, y: 0 });
    return { res, edges, after: p.planner.get().edges.length, toast: document.getElementById('toast')?.textContent };
  }, goodGraphV2());
  expect(out.res.ok).toBe(false);
  expect(out.res.errors[0]).toContain('cannot connect');
  expect(out.after).toBe(out.edges);
  expect(out.toast).toContain('cannot connect');
});

test('window.planner.connect(lane → record) creates a does edge and opens its card', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const id = p.planner.connect('sess_siebel_admin', 'expense');
    const doc = p.planner.get();
    return {
      id,
      edge: doc.edges.find((e) => e.id === id),
      sel: p.P2.state.sel,
      cardOpen: p.P2.state.cardOpen,
      cardShown: !document.getElementById('ncard')!.classList.contains('hide'),
      drawn: p.P2.canvas.instance().getElementById(`step:${String(id)}`).length,
      valid: p.planner.validate().ok,
    };
  }, goodGraphV2());
  expect(out.edge?.type).toBe('does');
  expect(out.sel).toEqual({ kind: 'step', id: out.id });
  expect(out.cardOpen).toBe(true);
  expect(out.cardShown).toBe(true);
  expect(out.drawn).toBe(1);
  expect(out.valid).toBe(true);
});

// ------------------------------------------------------- §6 box select

test('parity §6 · selectMany shows the group box with its count', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    p.planner.selectMany(['sess_sf_sales', 'expense']);
    const box = document.getElementById('groupbox')!;
    return {
      api: p.planner.groupBox(),
      hidden: box.classList.contains('hide'),
      grip: !!document.getElementById('gb_grip'),
      hits: box.querySelectorAll('.gb_hit').length,
      selection: p.planner.selection(),
      msel: p.P2.state.msel,
    };
  }, goodGraphV2());
  expect(out.api).toEqual({ visible: true, count: '2 nodes' });
  expect(out.hidden).toBe(false);
  expect(out.grip).toBe(true);
  expect(out.hits).toBe(4);
  expect(out.selection).toEqual({ nodes: ['sess_sf_sales', 'expense'], edges: [] });
  expect(out.msel).toEqual(['sess_sf_sales', 'expense']);
});

test('parity §6 · SPACE arms the rubber band, and boxend refreshes the frame', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const armPoint = await emptyPoint(page);
  await page.mouse.click(armPoint.x, armPoint.y);
  await page.keyboard.down('Space');
  const armed = await page.evaluate(() => (window as unknown as V2Window).P2.canvas.instance().boxSelectionEnabled());
  await page.keyboard.up('Space');
  const disarmed = await page.evaluate(() => (window as unknown as V2Window).P2.canvas.instance().boxSelectionEnabled());
  expect(armed).toBe(true);
  expect(disarmed).toBe(false);

  // A box that ended with two nodes selected raises the frame.
  const out = await page.evaluate(async () => {
    const p = (window as unknown as V2Window);
    p.planner.selectMany(['sess_sf_admin', 'expense']);
    p.P2.canvas.instance().emit('boxend');
    await new Promise((r) => setTimeout(r, 60));
    return p.planner.groupBox();
  });
  expect(out.visible).toBe(true);
  expect(out.count).toBe('2 nodes');
});

test('parity §6 · the group grip drags every selected node at once, in one edit', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); (window as unknown as V2Window).planner.selectMany(['sess_sf_admin', 'expense']); }, goodGraphV2());
  const depth = await page.evaluate(() => ((window as unknown as V2Window).P2.ops.undoDepth as unknown as () => number)());
  const grip = await page.locator('#gb_grip').boundingBox();
  expect(grip).toBeTruthy();
  await drag(page, { x: grip!.x + grip!.width / 2, y: grip!.y + grip!.height / 2 }, 50, 30);
  const out = await page.evaluate(() => {
    const doc = (window as unknown as V2Window).planner.get();
    return {
      moved: doc.nodes.filter((n) => !!n.pos).map((n) => n.id).sort(),
      valid: (window as unknown as V2Window).planner.validate().ok,
      depth: ((window as unknown as V2Window).P2.ops.undoDepth as unknown as () => number)(),
    };
  });
  expect(out.moved).toEqual(['expense', 'sess_sf_admin']);
  expect(out.valid).toBe(true);
  expect(out.depth).toBe(depth + 1);   // one gesture, one undo step
});

// ------------------------------------------------------------ §6 dbltap

test('parity §6 · double-clicking empty canvas adds a session where you clicked', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const before = await page.evaluate(() => (window as unknown as V2Window).planner.get().nodes.filter((n) => n.type === 'session').length);
  const at = await page.evaluate(() => {
    const r = document.getElementById('cy')!.getBoundingClientRect();
    return { x: r.left + 18, y: r.bottom - 14 };
  });
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(200);
  const out = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    const doc = p.planner.get();
    const sessions = doc.nodes.filter((n) => n.type === 'session');
    return {
      count: sessions.length,
      positioned: !!sessions[sessions.length - 1]?.pos,
      selected: p.P2.state.sel,
      lanes: p.P2.canvas.instance().nodes('.lane').length,
      valid: p.planner.validate().ok,
    };
  });
  expect(out.count).toBe(before + 1);
  expect(out.positioned).toBe(true);
  expect(out.selected.kind).toBe('session');
  expect(out.lanes).toBe(out.count);
  expect(out.valid).toBe(true);
});

test('parity §6 · double-clicking a lane starts its recording', async ({ page }) => {
  await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    p.P2.canvas.fit();
    (window as unknown as { _rec: string[] })._rec = [];
    p.P2.ops.record = ((id: string) => { (window as unknown as { _rec: string[] })._rec.push(id); return Promise.resolve({ ok: true }); }) as never;
  }, goodGraphV2());
  const at = await centreOf(page, 'sess_sf_admin', 4);
  await page.mouse.dblclick(at.x, at.y);
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as unknown as { _rec: string[] })._rec)).toEqual(['sess_sf_admin']);
});

// --------------------------------------------------------- ● record overlay

test('there is a ● record button over every lane; it pulses while recording', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const dots = () => Array.from(document.querySelectorAll('.cyover .recdot')).map((b) => ({
      id: (b as HTMLElement).dataset.rec, cls: b.className, text: b.textContent,
    }));
    const idle = dots();
    p.P2.state.recording.sess_sf_admin = { status: 'running', tail: [] };
    p.P2.ui.render();
    const live = dots();
    delete p.P2.state.recording.sess_sf_admin;
    p.P2.ops.setSessionField!('sess_sf_sales' as never, 'captured' as never, true as never);
    p.P2.ui.render();
    return { idle, live, captured: dots() };
  }, goodGraphV2());
  expect(out.idle.map((d) => d.id)).toEqual(['sess_sf_sales', 'sess_sf_admin', 'sess_siebel_admin']);
  expect(out.idle.every((d) => d.text === '●')).toBe(true);
  expect(out.live[1]!.cls).toContain('recording');
  expect(out.captured[0]!.cls).toContain('captured');
  expect(out.captured[0]!.text).toBe('✓');
});

test('clicking a lane\'s ● record starts the recorder for that session', async ({ page }) => {
  await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    p.P2.canvas.fit();
    (window as unknown as { _rec: string[] })._rec = [];
    p.P2.ops.record = ((id: string) => { (window as unknown as { _rec: string[] })._rec.push(id); return Promise.resolve({ ok: true }); }) as never;
  }, goodGraphV2());
  await page.waitForTimeout(60);
  await page.locator('.cyover .recdot[data-rec="sess_siebel_admin"]').click();
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => (window as unknown as { _rec: string[] })._rec)).toEqual(['sess_siebel_admin']);
});

// ------------------------------------------------------------- §6 selection

test('parity §6 · tapping a lane, a step and a record each open the right card', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());

  await page.mouse.click(...Object.values(await centreOf(page, 'sess_sf_admin', 4)) as [number, number]);
  expect(await page.evaluate(() => (window as unknown as V2Window).P2.state.sel)).toEqual({ kind: 'session', id: 'sess_sf_admin' });

  const step = await centreOf(page, 'step:e5');
  await page.mouse.click(step.x, step.y);
  expect(await page.evaluate(() => (window as unknown as V2Window).P2.state.sel)).toEqual({ kind: 'step', id: 'e5' });

  // Escape first: since S3.4 a record sits directly UNDER the lane that first
  // touches it, so the card glued to the step above would be over the record
  // and the click would land on the card, not the canvas.
  await page.keyboard.press('Escape');
  // A record is SHARED: the card that opens is the first step that lands on
  // it, because that is the line carrying its checks.
  const rec = await centreOf(page, 'expense');
  await page.mouse.click(rec.x, rec.y);
  expect(await page.evaluate(() => (window as unknown as V2Window).P2.state.sel)).toEqual({ kind: 'step', id: 'e2' });

  // Empty canvas closes the card without changing the document.
  const empty = await emptyPoint(page);
  await page.mouse.click(empty.x, empty.y);
  await page.waitForTimeout(60);
  expect(await page.evaluate(() => (window as unknown as V2Window).P2.state.cardOpen)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as V2Window).planner.validate().ok)).toBe(true);
});

test('parity §6 · anchor() tracks the selected node so the card stays glued', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  // The card glues to the canvas only when the CANVAS made the selection —
  // a line clicked in the script pane keeps its card beside the line, or the
  // card would sit on top of the pane being typed into.
  const fromScript = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    p.P2.ui.select({ kind: 'session', id: 'sess_sf_admin' }, false);
    return p.P2.canvas.anchor({ kind: 'session', id: 'sess_sf_admin' });
  });
  expect(fromScript).toBeNull();

  const lane = await centreOf(page, 'sess_sf_admin', 4);
  await page.mouse.click(lane.x, lane.y);
  await page.waitForTimeout(60);

  const out = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    const el = p.P2.canvas.anchor(p.P2.state.sel)!;
    const cy = p.P2.canvas.instance();
    const stage = document.getElementById('cy')!.getBoundingClientRect();
    const bb = cy.getElementById('sess_sf_admin').renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    const a = el.getBoundingClientRect();
    const node = { x1: stage.left + bb.x1, y1: stage.top + bb.y1, x2: stage.left + bb.x2, y2: stage.top + bb.y2 };
    const overlaps = a.left < node.x2 && a.right > node.x1 && a.top < node.y2 && a.bottom > node.y1;
    // Panning must carry the anchor — and the card — with it.
    const was = { x: a.left, y: a.top };
    cy.pan({ x: cy.pan().x + 60, y: cy.pan().y + 40 });
    const moved = el.getBoundingClientRect();
    return {
      sel: p.P2.state.sel, overlaps,
      dx: Math.round(moved.left - was.x), dy: Math.round(moved.top - was.y),
      nullForGraph: p.P2.canvas.anchor({ kind: 'graph', id: '' }),
    };
  });
  expect(out.sel).toEqual({ kind: 'session', id: 'sess_sf_admin' });
  expect(out.overlaps).toBe(true);
  expect(out.dx).toBe(60);
  expect(out.dy).toBe(40);
  expect(out.nullForGraph).toBeNull();
});

test('Delete removes the line selected on the canvas', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const step = await centreOf(page, 'step:e5');
  await page.mouse.click(step.x, step.y);
  await page.keyboard.press('Delete');
  const out = await page.evaluate(() => ({
    edge: (window as unknown as V2Window).planner.get().edges.find((e) => e.id === 'e5') ?? null,
    drawn: (window as unknown as V2Window).P2.canvas.instance().getElementById('step:e5').length,
    valid: (window as unknown as V2Window).planner.validate().ok,
  }));
  expect(out.edge).toBeNull();
  expect(out.drawn).toBe(0);
  expect(out.valid).toBe(true);
});

// --------------------------------------------------------------- §6 hover

test('parity §6 · hovering a node explains it, in the same words v1 used', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); (window as unknown as V2Window).P2.canvas.fit(); }, goodGraphV2());
  const rec = await centreOf(page, 'expense');
  await page.mouse.move(rec.x - 4, rec.y - 60);
  await page.mouse.move(rec.x, rec.y, { steps: 4 });
  await page.waitForTimeout(200);
  const out = await page.evaluate(() => {
    const tip = document.querySelector('#cy > .cytip')!;
    return { on: tip.classList.contains('on'), text: tip.textContent, same: (window as unknown as V2Window).planner.tipFor('expense') };
  });
  expect(out.on).toBe(true);
  expect(out.text).toContain('data record');
  expect(out.text).toBe(out.same);
});

// ------------------------------------------------------------ §6 run paint

test('parity §6 · a run-painted graph shows pass / fail borders, timings and ✓ recorded', async ({ page }) => {
  const painted = (): unknown => {
    const g = goodGraphV2() as unknown as Doc;
    const expense = g.nodes.find((n) => n.id === 'expense')!;
    expense.expects![0]!.lastResult = { status: 'pass', at: '2026-09-03T10:00:00Z' };
    expense.expects![1]!.lastResult = { status: 'fail', at: '2026-09-03T10:00:00Z' };
    const sales = g.nodes.find((n) => n.id === 'sess_sf_sales')!;
    sales.steps = { status: 'captured' };
    sales.timing = { capturedMeanMs: 4200 };
    return g;
  };
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    const cls = (id: string) => cy.getElementById(id).classes().join(' ');
    return {
      record: cls('expense'),
      submit: cls('step:e2'),
      approve: cls('step:e5'),
      adminLane: cls('sess_sf_admin'),
      laneLabel: String(cy.getElementById('sess_sf_sales').data('label')),
      stepLabel: String(cy.getElementById('step:e5').data('label')),
      valid: p.planner.validate().ok,
    };
  }, painted());
  expect(out.record).toContain('fail');
  expect(out.submit).toContain('pass');
  expect(out.approve).toContain('fail');
  expect(out.adminLane).toContain('fail');
  // The captured chip and the captured mean ride on the lane header.
  expect(out.laneLabel).toContain('✓ recorded');
  expect(out.laneLabel).toContain('4.2s');
  // …and a step's own timing on the step box.
  expect(out.stepLabel).toContain('1.2s');
  expect(out.valid).toBe(true);
});

test('a step box says what the step is: verb, record, catalog, port and checks', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    return {
      submit: String(cy.getElementById('step:e2').data('label')),
      denied: String(cy.getElementById('step:e3').data('label')),
      record: String(cy.getElementById('expense').data('label')),
      lane: String(cy.getElementById('sess_siebel_admin').data('label')),
    };
  }, goodGraphV2());
  expect(out.submit.split('\n')[0]).toBe('submit Expense record');
  expect(out.submit.split('\n')[1]).toContain('expense.submit');
  expect(out.submit.split('\n')[1]).toContain('produces');
  expect(out.submit.split('\n')[1]).toContain('1 check');
  expect(out.denied.split('\n')[0]).toContain('✕ must not');
  expect(out.record).toBe('Expense record\nExpense__c');
  // The lane header is `<system> · <role>` (infer.sessionLabel) over its state.
  expect(out.lane.split('\n')[0]).toBe('Siebel · siebel_approver');
  expect(out.lane.split('\n')[1]).toBe('not recorded yet');
});

// ------------------------------------------------------- viewport + diffing

test('pan and zoom survive an edit — the canvas patches, it does not rebuild', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    cy.zoom(0.77);
    cy.pan({ x: 31, y: 47 });
    const idsBefore = p.P2.canvas.nodes().slice().sort();
    const lines = p.P2.view.lines(p.planner.get());
    p.P2.ops.setStepField!(lines.sessions[0]!.steps[0]!.edgeId as never, 'verb' as never, 'raise' as never);
    p.P2.ui.render();
    return {
      zoom: cy.zoom(), pan: cy.pan(),
      idsBefore, idsAfter: p.P2.canvas.nodes().slice().sort(),
      label: String(cy.getElementById('step:e2').data('label')),
    };
  }, goodGraphV2());
  expect(out.zoom).toBe(0.77);
  expect(out.pan).toEqual({ x: 31, y: 47 });
  expect(out.idsAfter).toEqual(out.idsBefore);          // patched by id, not recreated
  expect(out.label).toContain('raise Expense record');
});

test('fit() zooms to everything, and the canvas footer buttons are wired to it', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const p = (window as unknown as V2Window);
    p.planner.load(g);
    const cy = p.P2.canvas.instance();
    cy.zoom(3);
    document.getElementById('b_fit')!.click();
    const fitted = cy.zoom();
    cy.zoom(3);
    p.P2.canvas.fit();
    return { fitted, again: cy.zoom(), layoutBtn: !!document.getElementById('b_layout'), graphBtn: !!document.getElementById('b_graphcard2') };
  }, goodGraphV2());
  expect(out.fitted).toBeLessThan(3);
  expect(out.again).toBeLessThan(3);
  expect(out.layoutBtn).toBe(true);
  expect(out.graphBtn).toBe(true);
});

test('the canvas keeps its instance across a tab switch — only CSS moves', async ({ page }) => {
  const out = await page.evaluate(() => {
    const p = (window as unknown as V2Window);
    const before = p.P2.canvas.instance();
    document.querySelector<HTMLElement>('[role=tab][data-tab="script"]')!.click();
    const hiddenAnchor = p.P2.canvas.anchor({ kind: 'session', id: p.P2.view.lines(p.planner.get()).sessions[0]!.id });
    document.querySelector<HTMLElement>('[role=tab][data-tab="canvas"]')!.click();
    return { same: before === p.P2.canvas.instance(), hiddenAnchor, view: document.getElementById('view')!.className };
  });
  expect(out.same).toBe(true);
  // While the canvas is off screen the card falls back to the script line.
  expect(out.hiddenAnchor).toBeNull();
  expect(out.view).toContain('tab-canvas');
});

// ------------------------------------------------------------- parity table

test('every parity §6 gesture is claimed as shipped by this spec', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/PLANNER-FEATURE-PARITY.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 6.'), doc.indexOf('## 7.'));
  const rows = section.split('\n').filter((l) => l.startsWith('|') && !/^\|\s*(Gesture|-)/.test(l));
  expect(rows.length).toBeGreaterThan(10);
  const open: string[] = [];
  for (const row of rows) {
    const cells = row.split('|').map((c) => c.trim()).filter((_c, i, a) => i > 0 && i < a.length - 1);
    if ((cells[5] ?? '').includes('○')) open.push(cells[0] ?? row);
  }
  expect(open, 'parity §6 rows still marked ○ after sprint 3.2').toEqual([]);
});
