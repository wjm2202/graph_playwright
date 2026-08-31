/**
 * PG-2 — the planner, tested by the framework it plans for. Drives the
 * committed single-file tools/process-planner.html over file:// — boot,
 * load/validate, selection→form binding, form→graph writeback, add/connect,
 * deny guard, dagre layout + position persistence, view mode, snapshot
 * attach, and an export/import round-trip.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { goodGraph, goodGraphV2 } from '../helpers/sampleGraph';

const PLANNER = pathToFileURL(path.resolve('tools/process-planner.html')).href;
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

declare global {
  interface Window {
    planner: {
      load(input: unknown): { ok: boolean; errors: string[] };
      export(): { json: string; ok: boolean; errors: string[] };
      get(): { nodes: Record<string, unknown>[]; edges: Record<string, unknown>[] };
      addNode(partial?: Record<string, unknown>): string;
      connect(from: string, to: string, type?: string): string;
      select(id: string): void;
      setMode(m: string): void;
      validate(): { ok: boolean; errors: string[] };
      save(mode: 'save' | 'overwrite' | 'saveas'): { ok: boolean; errors: string[] };
      testCommands(): { spec: string; run: string } | null;
      readiness(): string;
      suggestCatalog(edgeId: string): string | null;
      newGraph(force?: boolean): boolean;
      addTyped(type: string): string;
      tipFor(id: string): string;
      issues(): { errors: string[]; gaps: { kind: string; at: string; question: string }[] };
      library(): { builtIn: string[]; saved: string[] };
      openFromLibrary(value: string): void;
      version: string;
    };
    cy: unknown;
  }
}

test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  // The single-file planner is ~1MB of inline script — under parallel worker
  // load in the sandbox, boot can exceed the 15s default. 30s is honest.
  await page.waitForFunction(() => !!window.planner, undefined, { timeout: 30_000 });
});

test('boots self-contained: schema + cytoscape inlined, empty graph valid', async ({ page }) => {
  // Fresh load with an error trap: EVERY inlined library must initialize —
  // a swallowed load error (the edgehandles/lodash incident) fails here.
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!window.planner);

  expect(await page.evaluate(() => window.planner.version)).toBe('planner/1');
  expect(await page.evaluate(() => typeof (window as never as Record<string, unknown>).cytoscape)).toBe('function');
  // Drag-to-connect machinery actually registered (guards the lodash inline):
  expect(
    await page.evaluate(() => typeof (window as unknown as { cy: Record<string, unknown> }).cy.edgehandles),
  ).toBe('function');
  expect(pageErrors).toEqual([]);
  await expect(page.locator('#status')).toHaveClass('ok');
  await expect(page.locator('#status')).toContainText('valid · 0 nodes · 0 edges');
});

test('loads the v2 relation seed: rendered counts and validity reported', async ({ page }) => {
  const r = await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  expect(r.ok).toBe(true);
  await expect(page.locator('#status')).toContainText('valid · 6 nodes · 8 edges');
});

test('v1 graphs still load through the same door (backward compatibility)', async ({ page }) => {
  const r = await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  expect(r.ok).toBe(true);
  await expect(page.locator('#status')).toContainText('valid · 5 nodes · 5 edges');
});

test('load REFUSES an invalid graph, naming the problems', async ({ page }) => {
  const bad = goodGraph();
  bad.edges.push({ id: 'x1', from: 'submit', to: 'ghost', type: 'next' });
  const r = await page.evaluate((g) => window.planner.load(g), bad as unknown as Record<string, unknown>);
  expect(r.ok).toBe(false);
  await expect(page.locator('#status')).toContainText("unknown node 'ghost'");
  await expect(page.locator('#status')).toContainText('load refused');
});

test('selecting a node binds the four data points into the form', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('submit'); });
  await expect(page.locator('#nf_label')).toHaveValue('Submit expense');
  await expect(page.locator('#nf_system')).toHaveValue('sf');
  await expect(page.locator('#nf_actor')).toHaveValue('submitter');
  await expect(page.locator('#nf_account')).toHaveValue('SF_SALES_USERNAME');
  await expect(page.locator('#nf_catalog')).toHaveValue('expense.submit');
  await expect(page.locator('#nf_steps_status')).toHaveValue('planned');
  await expect(page.locator('#nf_planned')).toHaveValue('30000');
});

test('panel v1.1: capture cockpit up front, secondary fields collapsed', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('submit'); });

  // Primary strip: url, role/user, account, start-capture with the exact command.
  await expect(page.locator('#nf_capture')).toBeEnabled();
  await expect(page.locator('#nf_capture_cmd')).toHaveValue(
    'RECORD_PERSONA=sales_user RECORD_JOURNEY=expense_to_siebel npm run record',
  );
  // Secondary fields live inside a collapsed details section.
  const details = page.locator('#nf_details');
  await expect(details).not.toHaveAttribute('open', '');
  expect(await page.locator('#nf_details #nf_catalog').count()).toBe(1);
  expect(await page.locator('#nf_details #nf_notes').count()).toBe(1);

  // A node without a role can't capture — button disabled with guidance.
  await page.evaluate(() => { window.planner.select('start'); });
  await expect(page.locator('#nf_capture')).toBeDisabled();
  await expect(page.locator('#nf_capture_cmd')).toHaveValue(/set a role\/user first/);
});

test('form edits write back into the graph and the export', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('submit'); });
  await page.locator('#nf_label').fill('Submit expense v2');
  await page.locator('#nf_label').dispatchEvent('change');
  const out = await page.evaluate(() => window.planner.export());
  expect(out.ok).toBe(true);
  expect(out.json).toContain('Submit expense v2');
});

test('add + connect grow the graph; a deny edge without capability is caught', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  const ids = await page.evaluate(() => {
    const a = window.planner.addNode({ label: 'Siebel check', type: 'action' });
    const e = window.planner.connect('verify', a, 'next');
    return { a, e };
  });
  expect(ids.a).toBeTruthy();
  let out = await page.evaluate(() => window.planner.export());
  expect(out.ok).toBe(true);
  expect(await page.evaluate(() => window.planner.get().nodes.length)).toBe(6);

  await page.evaluate(() => window.planner.connect('submit', 'approve', 'deny'));
  out = await page.evaluate(() => window.planner.export());
  expect(out.ok).toBe(false);
  expect(out.errors.join()).toContain('deny edges require data.capability');
  await expect(page.locator('#status')).toHaveClass('bad');
});

test('dagre lays out un-positioned graphs; export persists positions', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  const out = await page.evaluate(() => window.planner.export());
  const doc = JSON.parse(out.json) as { nodes: { id: string; pos?: { x: number; y: number } }[] };
  expect(doc.nodes.every((n) => n.pos && Number.isFinite(n.pos.x))).toBe(true);
  const xs = new Set(doc.nodes.map((n) => n.pos!.x));
  expect(xs.size).toBeGreaterThan(1); // layered layout actually spread them
});

test('view mode disables editing controls', async ({ page }) => {
  await page.evaluate(() => { window.planner.setMode('view'); });
  await expect(page.locator('#b_add')).toBeDisabled();
  await expect(page.locator('#b_delete')).toBeDisabled();
  await page.evaluate(() => { window.planner.setMode('edit'); });
  await expect(page.locator('#b_add')).toBeEnabled();
});

test('snapshot slot: an image attaches as a data URL on the selected node', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('approve'); });
  await page.locator('#nf_snapshot').setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: PNG_1PX });
  await expect(page.locator('#status')).toContainText('snapshot attached');
  const out = await page.evaluate(() => window.planner.export());
  const doc = JSON.parse(out.json) as { nodes: { id: string; snapshot?: { status: string; ref?: string } }[] };
  const approve = doc.nodes.find((n) => n.id === 'approve')!;
  expect(approve.snapshot?.status).toBe('captured');
  expect(approve.snapshot?.ref).toMatch(/^data:image\/png;base64,/);
  await expect(page.locator('#nf_snapshot_img')).toBeVisible();
});

test('lane labels: v1 nodes get [system · actor]; v2 sessions ARE the lane', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  const v1 = await page.evaluate(() => {
    const cy = (window as unknown as { cy: { $id(id: string): { data(k: string): string } } }).cy;
    return cy.$id('submit').data('label');
  });
  expect(v1).toBe('Submit expense\n[sf · submitter]');

  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  const v2 = await page.evaluate(() => {
    const cy = (window as unknown as { cy: { $id(id: string): { data(k: string): string } } }).cy;
    return {
      sales: cy.$id('sess_sf_sales').data('label'),
      data: cy.$id('expense').data('label'),
      login: cy.$id('e1').data('label'),
      does: cy.$id('e2').data('label'),
      denied: cy.$id('e3').data('label'),
    };
  });
  expect(v2.sales).toBe('Salesforce · submitter  ▶'); // ▶ = double-click copies the capture command
  expect(v2.data).toBe('Expense record\n✓ 2 checks'); // oracle badge from expects
  expect(v2.login).toBe('login as submitter'); // the arrow names WHO, never the mechanism
  expect(v2.does).toBe('expense.submit · submit expense');
  expect(v2.denied).toBe('deny expense.approve');
});

test('what-to-test editor: rows bind, add/remove works, results paint the node', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('expense'); });

  // Seed oracles render as rows.
  await expect(page.locator('#xf_list select')).toHaveCount(2);
  await expect(page.locator('#xf_list input[data-f="target"]').first()).toHaveValue('Expense__c');

  // Add a check via the button and give it substance.
  await page.locator('#xf_add').click();
  await expect(page.locator('#xf_list select')).toHaveCount(3);
  const row3kind = page.locator('#xf_list select').nth(2);
  await row3kind.selectOption('ui.toast');
  await page.locator('#xf_list input[data-f="value"]').nth(2).fill('was saved');
  await page.locator('#xf_list input[data-f="value"]').nth(2).dispatchEvent('change');
  const out = await page.evaluate(() => window.planner.export());
  expect(out.ok).toBe(true);
  expect(out.json).toContain('"kind": "ui.toast"');
  expect(out.json).toContain('"value": "was saved"');

  // Badge counts three now; a failing result paints the node red.
  const state = await page.evaluate(() => {
    const cy = (window as unknown as { cy: { $id(id: string): { data(k: string): string } } }).cy;
    const label = cy.$id('expense').data('label');
    const G = window.planner.get() as unknown as { nodes: { id: string; expects?: { lastResult?: unknown }[] }[] };
    const expense = G.nodes.find((n) => n.id === 'expense')!;
    expense.expects![0]!.lastResult = { status: 'fail', at: 'now', message: 'record missing' };
    window.planner.select('expense');
    return { label };
  });
  expect(state.label).toBe('Expense record\n✓ 3 checks');
  // Re-sync visuals through the editor path (a change event re-renders):
  await page.evaluate(() => {
    const cyw = window as unknown as { cy: { $id(id: string): { data(k: string): string } } };
    const G = window.planner.get() as unknown as { nodes: { id: string }[] };
    void G; // state mutated above; force visual sync via load-free repaint:
    (window.planner as unknown as { load(g: unknown): unknown }).load(window.planner.get());
    return cyw.cy.$id('expense').data('exp');
  });
  const painted = await page.evaluate(() => {
    const cy = (window as unknown as { cy: { $id(id: string): { data(k: string): string } } }).cy;
    return { exp: cy.$id('expense').data('exp'), label: cy.$id('expense').data('label') };
  });
  expect(painted.exp).toBe('fail');
  expect(painted.label).toContain('✗ 3 checks');

  // Removing a row updates graph + badge.
  await page.evaluate(() => { window.planner.select('expense'); });
  await page.locator('#xf_list button[data-f="del"]').nth(2).click();
  expect(
    await page.evaluate(() => (window.planner.get() as unknown as { nodes: { id: string; expects?: unknown[] }[] }).nodes.find((n) => n.id === 'expense')!.expects!.length),
  ).toBe(2);
});

test('double-clicking a session node copies its capture command', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => {
    // A real double-click fires tap + dbltap; emit() sends only the named
    // event, so simulate the gesture's parts explicitly.
    const cy = (window as unknown as { cy: { $id(id: string): { select(): void; emit(e: string): void } } }).cy;
    cy.$id('sess_sf_sales').select();
    cy.$id('sess_sf_sales').emit('dbltap');
  });
  await expect(page.locator('#status')).toContainText('capture command copied for submitter');
  await expect(page.locator('#nf_capture_cmd')).toHaveValue(
    'RECORD_PERSONA=sales_user RECORD_JOURNEY=expense_to_siebel npm run record',
  );
});

test('edge form binds and edits the v2 relations (catalog, auth)', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);

  await page.evaluate(() => { window.planner.select('e2'); });
  await expect(page.locator('#ef_type')).toHaveValue('does');
  await expect(page.locator('#ef_catalog')).toHaveValue('expense.submit');
  await page.locator('#ef_catalog').fill('expense.submit_fast');
  await page.locator('#ef_catalog').dispatchEvent('change');
  const out = await page.evaluate(() => window.planner.export());
  expect(out.ok).toBe(true);
  expect(out.json).toContain('expense.submit_fast');

  await page.evaluate(() => { window.planner.select('e1'); });
  await expect(page.locator('#ef_type')).toHaveValue('login_as');
  await expect(page.locator('#ef_auth')).toHaveValue('frontdoor');
});

test('v2 session node drives the capture cockpit', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('sess_sf_sales'); });
  await expect(page.locator('#nf_label')).toHaveValue('Salesforce · submitter');
  await expect(page.locator('#nf_actor')).toHaveValue('submitter');
  await expect(page.locator('#nf_account')).toHaveValue('SF_SALES_USERNAME');
  await expect(page.locator('#nf_capture_cmd')).toHaveValue(
    'RECORD_PERSONA=sales_user RECORD_JOURNEY=expense_to_siebel npm run record',
  );
});

test('connect mode: click source then target draws the edge, with guidance shown', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  await page.locator('#b_connect').click();
  await expect(page.locator('#b_connect')).toHaveClass(/\bon\b/);
  await expect(page.locator('#status')).toContainText('CONNECT MODE: click a source node then a target node');

  const tap = (id: string) =>
    page.evaluate((nodeId) => {
      (window as unknown as { cy: { $id(id: string): { emit(e: string): void } } }).cy.$id(nodeId).emit('tap');
    }, id);

  await tap('submit');
  await expect(page.locator('#status')).toContainText('source: submit — now click the target node');
  await tap('verify');
  await expect(page.locator('#status')).toContainText('connected submit → verify');

  const edges = await page.evaluate(() => window.planner.get().edges);
  expect(edges.some((e) => e.from === 'submit' && e.to === 'verify' && e.type === 'next')).toBe(true);
  // Still in connect mode for the next pair; Esc leaves it:
  await expect(page.locator('#b_connect')).toHaveClass(/\bon\b/);
  await page.keyboard.press('Escape');
  await expect(page.locator('#b_connect')).not.toHaveClass(/\bon\b/);
  await expect(page.locator('#status')).toContainText('connect mode off');
});

test('library dropdown: built-in repo graphs are listed and load on selection', async ({ page }) => {
  const lib = await page.evaluate(() => window.planner.library());
  expect(lib.builtIn).toContain('expense_to_siebel');
  await expect(page.locator('#f_library optgroup[label="built-in (repo)"] option')).toHaveCount(lib.builtIn.length);

  await page.locator('#f_library').selectOption('lib:expense_to_siebel');
  await expect(page.locator('#status')).toContainText('valid · 6 nodes · 8 edges');
  expect(await page.evaluate(() => window.planner.get().nodes.length)).toBe(6);
  // The picker resets so the same graph can be re-opened later:
  await expect(page.locator('#f_library')).toHaveValue('');
});

test('save menu: new id saves; existing id offers overwrite; save-as renames', async ({ page }) => {
  const g = goodGraph();
  g.id = 'my_local_process';
  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);

  // New id → the menu's first action is a plain save.
  await page.locator('#f_save').dispatchEvent('mousedown');
  await expect(page.locator('#f_save option[value="save"]')).toHaveText('save "my_local_process"');
  await page.locator('#f_save').selectOption('save');
  await expect(page.locator('#status')).toContainText('saved "my_local_process" in this browser');
  let lib = await page.evaluate(() => window.planner.library());
  expect(lib.saved).toContain('my_local_process');

  // Same id again → the menu now offers overwrite, and it updates the copy.
  await page.evaluate(() => { window.planner.select('submit'); });
  await page.locator('#nf_label').fill('Submit expense OVERWRITTEN');
  await page.locator('#nf_label').dispatchEvent('change');
  await page.locator('#f_save').dispatchEvent('mousedown');
  await expect(page.locator('#f_save option[value="overwrite"]')).toHaveText('overwrite "my_local_process"');
  await page.locator('#f_save').selectOption('overwrite');
  await expect(page.locator('#status')).toContainText('overwrote "my_local_process" in this browser');
  const storedLabel = await page.evaluate(() => {
    const all = JSON.parse(localStorage.getItem('planner.graphs.v1') ?? '{}');
    return all.my_local_process.nodes.find((n: { id: string }) => n.id === 'submit').label;
  });
  expect(storedLabel).toBe('Submit expense OVERWRITTEN');

  // Save as… prompts for a new id, renames the working graph, keeps both copies.
  page.once('dialog', (d) => d.accept('my_local_process_v2'));
  await page.locator('#f_save').selectOption('saveas');
  await expect(page.locator('#status')).toContainText('saved "my_local_process_v2" in this browser');
  await expect(page.locator('#gf_id')).toHaveValue('my_local_process_v2');
  lib = await page.evaluate(() => window.planner.library());
  expect(lib.saved).toEqual(expect.arrayContaining(['my_local_process', 'my_local_process_v2']));

  // Saves survive a reload and reopen from the dropdown.
  await page.reload();
  await page.waitForFunction(() => !!window.planner);
  await page.locator('#f_library').selectOption('ls:my_local_process_v2');
  await expect(page.locator('#status')).toContainText('valid · 5 nodes · 5 edges');
});

test('export no longer auto-saves; invalid graphs refuse to save', async ({ page }) => {
  const g = goodGraph();
  g.id = 'never_saved';
  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);
  await page.evaluate(() => window.planner.export());
  const lib = await page.evaluate(() => window.planner.library());
  expect(lib.saved).not.toContain('never_saved');

  await page.evaluate(() => window.planner.connect('submit', 'approve', 'denied')); // missing capability
  const r = await page.evaluate(() => window.planner.save('save'));
  expect(r.ok).toBe(false);
  await expect(page.locator('#status')).toContainText('cannot save an invalid graph');
});

test('export → load round-trip is lossless (positions included)', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraph() as unknown as Record<string, unknown>);
  const first = await page.evaluate(() => window.planner.export());
  const r = await page.evaluate((json) => window.planner.load(json), first.json);
  expect(r.ok).toBe(true);
  const second = await page.evaluate(() => window.planner.export());
  expect(second.json).toBe(first.json);
});

test('new: a fresh graph arrives with start + end waiting, not a blank stare', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => window.planner.newGraph(true));
  const g = await page.evaluate(() => window.planner.get());
  expect((g.nodes as { id: string; type: string }[]).map((n) => `${n.id}:${n.type}`)).toEqual(['start:start', 'end:end']);
  expect(g.edges).toEqual([]);
  await expect(page.locator('#status')).toContainText('new graph — give it an id, then add ▾');
  await expect(page.locator('#b_new')).toBeEnabled();
});

test('add ▾: typed nodes with readable ids; the panel shows only what the type uses', async ({ page }) => {
  await page.evaluate(() => window.planner.newGraph(true));

  // The toolbar path — pick "database" from add ▾:
  await page.evaluate(() => {
    const el = document.getElementById('b_add') as HTMLSelectElement;
    el.value = 'db';
    el.dispatchEvent(new Event('change'));
  });
  const db = await page.evaluate(() =>
    window.planner.get().nodes.find((n) => (n as { id: string }).id === 'db_1')!,
  );
  expect(db).toMatchObject({ type: 'db', label: 'Database' });
  expect(db.queryable).toBeUndefined(); // NOT queryable until a human says so

  // Type-aware panel: db shows the queryable switch, never role/user:
  await expect(page.locator('#row_queryable')).toBeVisible();
  await expect(page.locator('#row_actor')).toBeHidden();
  await expect(page.locator('#row_capture')).toBeHidden();
  await expect(page.locator('#status')).toContainText('db.query');

  // Ticking queryable writes it back and the label announces it:
  await page.locator('#nf_queryable').check();
  await page.locator('#nf_queryable').dispatchEvent('change');
  expect(await page.evaluate(() =>
    (window.planner.get().nodes.find((n) => (n as { id: string }).id === 'db_1') as { queryable?: boolean }).queryable,
  )).toBe(true);

  // A session flips the panel the other way:
  await page.evaluate(() => window.planner.addTyped('session'));
  await expect(page.locator('#row_actor')).toBeVisible();
  await expect(page.locator('#row_capture')).toBeVisible();
  await expect(page.locator('#row_queryable')).toBeHidden();
});

test('api endpoint nodes: create_customer_v2 with method + path, worn on the label', async ({ page }) => {
  await page.evaluate(() => window.planner.newGraph(true));
  await page.evaluate(() => window.planner.addTyped('api'));

  await expect(page.locator('#row_endpoint')).toBeVisible();
  await page.locator('#nf_label').fill('create_customer_v2');
  await page.locator('#nf_label').dispatchEvent('change');
  await page.locator('#nf_method').selectOption('PUT');
  await page.locator('#nf_path').fill('/services/apexrest/create_customer_v2');
  await page.locator('#nf_path').dispatchEvent('change');

  const api = await page.evaluate(() =>
    window.planner.get().nodes.find((n) => (n as { id: string }).id === 'api_1')!,
  );
  expect(api.endpoint).toEqual({ method: 'PUT', path: '/services/apexrest/create_customer_v2' });
  const label = await page.evaluate(() =>
    (window.cy as { $id(id: string): { data(k: string): string } }).$id('api_1').data('label'),
  );
  expect(label).toContain('create_customer_v2');
  expect(label).toContain('[api · PUT]');
});

test('checks can target infra: db.query kind offered with a poll budget box; ? toggles the legend', async ({ page }) => {
  const g = goodGraphV2() as unknown as { nodes: { id: string; expects?: Record<string, unknown>[] }[] };
  g.nodes.push({ id: 'db_siebel', type: 'db', label: 'Siebel DB', queryable: true } as never);
  g.nodes.find((n) => n.id === 'expense')!.expects!.push({
    id: 'row_in_siebel', kind: 'db.query', target: 'db_siebel', value: 'S_EXP WHERE X', timeoutMs: 120000, pollMs: 5000,
  });
  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('expense'); });

  const kindOptions = await page.locator('#xf_list select[data-f="kind"]').first().locator('option').allTextContents();
  expect(kindOptions).toContain('db.query');
  expect(kindOptions).toContain('log.traffic');
  // The db.query row exposes the polling budget:
  await expect(page.locator('#xf_list input[data-f="timeoutMs"]')).toHaveCount(3); // 2 api rows + the db row

  await expect(page.locator('#legend')).toBeHidden();
  await page.locator('#b_help').click();
  await expect(page.locator('#legend')).toBeVisible();
  await expect(page.locator('#legend')).toContainText('only if queryable');
  await page.locator('#legend').click(); // clicking the card dismisses it
  await expect(page.locator('#legend')).toBeHidden();
});

test('node cards: settings live ON the node — tiered per type, glued to the canvas', async ({ page }) => {
  const nextFrame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => { r(null); })));
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('sess_sf_sales'); });
  await nextFrame(); // card placement is rAF-throttled

  // The card is up, typed, and sitting next to the node it edits:
  await expect(page.locator('#p_node')).toBeVisible();
  await expect(page.locator('#nf_typechip')).toHaveText('session');
  const geom = await page.evaluate(() => {
    const cyt = window.cy as { $id(id: string): { renderedBoundingBox(): { x1: number; x2: number; y1: number } } };
    const bb = cyt.$id('sess_sf_sales').renderedBoundingBox();
    const rect = document.getElementById('cy')!.getBoundingClientRect();
    const card = document.getElementById('p_node')!.getBoundingClientRect();
    return { nodeRight: rect.left + bb.x2, cardLeft: card.left, cardTop: card.top };
  });
  expect(geom.cardLeft).toBeGreaterThanOrEqual(geom.nodeRight); // flyout, not a far-away panel

  // Session primaries on the card; secondaries behind the toggle; foreign rows gone:
  expect(await page.locator('#np_main #nf_actor').count()).toBe(1);
  expect(await page.locator('#np_main #nf_capture').count()).toBe(1);
  expect(await page.locator('#np_extra #nf_notes').count()).toBe(1);
  await expect(page.locator('#row_queryable')).toBeHidden();

  // Drag the node elsewhere → the card follows, keeping its flyout offset.
  // (Gluing is verified via node movement; cy.panBy crashes THIS sandbox's
  // headless chromium — a sandbox quirk, not a planner bug. Same glue code
  // serves both events.)
  await page.evaluate(() => {
    (window.cy as { $id(id: string): { position(p: { x: number; y: number }): void } }).$id('sess_sf_sales').position({ x: 520, y: 330 });
  });
  await nextFrame();
  const geom2 = await page.evaluate(() => {
    const cyt = window.cy as { $id(id: string): { renderedBoundingBox(): { x1: number; x2: number } } };
    const bb = cyt.$id('sess_sf_sales').renderedBoundingBox();
    const rect = document.getElementById('cy')!.getBoundingClientRect();
    const card = document.getElementById('p_node')!.getBoundingClientRect();
    return { nodeLeft: rect.left + bb.x1, nodeRight: rect.left + bb.x2, cardLeft: card.left, cardRight: card.right };
  });
  // Still glued: the card hugs the node on WHICHEVER side fits the viewport.
  const gap = Math.min(
    Math.abs(geom2.cardLeft - geom2.nodeRight),
    Math.abs(geom2.nodeLeft - geom2.cardRight),
  );
  expect(gap).toBeLessThanOrEqual(20);
  expect(Math.round(geom2.cardLeft)).not.toBe(Math.round(geom.cardLeft)); // and it moved

  // A data node re-tiers the card: checks up front, no role machinery:
  await page.evaluate(() => { window.planner.select('expense'); });
  expect(await page.locator('#np_main #xf_list').count()).toBe(1);
  await expect(page.locator('#row_actor')).toBeHidden();

  // start has nothing to configure — and says so instead of showing a form:
  await page.evaluate(() => { window.planner.select('start'); });
  await expect(page.locator('#np_none')).toBeVisible();

  // Edges get the same treatment at their midpoint:
  await page.evaluate(() => { window.planner.select('e2'); });
  await expect(page.locator('#p_edge')).toBeVisible();
  await expect(page.locator('#ef_catalog')).toHaveValue('expense.submit');
});

test('session card: credentials block names the .env wiring; status dots color when the server tells; recorded chip flips', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('sess_sf_sales'); });

  // The wiring is on the card — url/username/password/token/totp env NAMES
  // straight from the real personas.json (values never appear anywhere):
  const creds = page.locator('#nf_creds');
  await expect(creds).toBeVisible();
  await expect(creds).toContainText('SF_INSTANCE_URL');
  await expect(creds).toContainText('SF_SALES_USERNAME');
  await expect(creds).toContainText('SF_SALES_PASSWORD');
  await expect(creds).toContainText('SF_SALES_TOTP_SECRET');
  // Without a dev server the dots are neutral, with guidance:
  await expect(creds.locator('span[title*="npm run planner"]').first()).toBeVisible();

  // When the dev server reports presence (served mode), dots go green/red:
  await page.evaluate(() => {
    (window as never as { PLANNER_FORCE_SERVED: boolean }).PLANNER_FORCE_SERVED = true;
    (window as never as { ENV_STATUS: Record<string, boolean> }).ENV_STATUS = {
      SF_INSTANCE_URL: true, SF_SALES_USERNAME: true, SF_SALES_PASSWORD: false, SF_SALES_TOTP_SECRET: false,
    };
    window.planner.select('start'); window.planner.select('sess_sf_sales'); // re-render
  });
  await expect(creds.locator('span[title="set in .env"]')).toHaveCount(2);
  expect(await creds.locator('span[title="MISSING from .env"]').count()).toBeGreaterThanOrEqual(2);
  await expect(creds).toContainText('values stay in .env');
  await expect(creds.locator('input[data-cred="username"]')).toHaveValue('SF_SALES_USERNAME');

  // Recorded chip: amber "record now" until a capture backs the session:
  const chip = page.locator('#nf_recchip');
  await expect(chip).toHaveText('● record now');
  await expect(page.locator('#nf_capture')).toHaveText('▶ start capture');
  await page.evaluate(() => {
    const n = window.planner.get().nodes.find((x) => (x as { id: string }).id === 'sess_sf_sales') as { steps?: unknown };
    n.steps = { status: 'captured', journeyId: 'expense_v2' };
    window.planner.select('start'); window.planner.select('sess_sf_sales');
  });
  await expect(chip).toHaveText('● recorded');
  await expect(page.locator('#nf_capture')).toHaveText('↻ re-record');

  // Compact layout: plain rows are two-column (label beside input), tall rows opt out:
  const flexed = await page.evaluate(() => getComputedStyle(document.getElementById('row_actor')!).display);
  expect(flexed).toBe('flex');
  const wide = await page.evaluate(() => getComputedStyle(document.getElementById('row_creds')!).display);
  expect(wide).toBe('block');

  // Guests say so instead of listing credentials:
  await page.evaluate(() => {
    const g2 = window.planner.get() as unknown as { actors: Record<string, string> };
    g2.actors.submitter = 'guest';
    window.planner.select('start'); window.planner.select('sess_sf_sales');
  });
  await expect(creds).toContainText('unauthenticated, no credentials needed');
});

test('graph meta is a card, not a column: hidden by default, toolbar toggles, new opens it — canvas gets the width', async ({ page }) => {
  // No aside eating 300px — the canvas spans the window:
  expect(await page.evaluate(() => document.querySelector('aside'))).toBeNull();
  const widths = await page.evaluate(() => ({
    cy: document.getElementById('cy')!.getBoundingClientRect().width,
    win: window.innerWidth,
  }));
  expect(widths.cy).toBeGreaterThan(widths.win - 30);

  await expect(page.locator('#p_meta')).toBeHidden();
  await page.locator('#b_graphmeta').click();
  await expect(page.locator('#p_meta')).toBeVisible();
  await page.locator('#pm_close').click();
  await expect(page.locator('#p_meta')).toBeHidden();

  // A new graph starts with naming — the meta card opens itself:
  await page.evaluate(() => window.planner.newGraph(true));
  await expect(page.locator('#p_meta')).toBeVisible();
  await expect(page.locator('#gf_id')).toBeFocused();
});

test('header chips get their own row — the label input keeps its full width', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('sess_sf_sales'); });
  // Chips live in a dedicated row below the title, never floated over fields:
  await expect(page.locator('#nf_chips #nf_recchip')).toBeVisible();
  await expect(page.locator('#nf_chips #nf_typechip')).toHaveText('session');
  const labelWidth = await page.evaluate(() => document.getElementById('nf_label')!.getBoundingClientRect().width);
  expect(labelWidth).toBeGreaterThan(150); // was squeezed to ~90px by the float
});

test('optional credentials can be switched OFF: ✕ clears the mapping, the nag stops', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => {
    (window as never as { PLANNER_FORCE_SERVED: boolean }).PLANNER_FORCE_SERVED = true;
    (window as never as { ENV_STATUS: Record<string, boolean> }).ENV_STATUS = { SF_INSTANCE_URL: true };
    window.fetch = ((_url: string, opts?: { body?: string }) => {
      const body = JSON.parse(opts!.body!) as Record<string, string>;
      const wiring: Record<string, string> = {
        username: 'SF_SALES_USERNAME', password: 'SF_SALES_PASSWORD', token: 'SF_SALES_TOKEN',
        url: 'SF_INSTANCE_URL', kind: 'internal',
      };
      if (body.totpEnv !== '') wiring.totp = 'SF_SALES_TOTP_SECRET';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, wiring, envstatus: { SF_INSTANCE_URL: true } }),
      });
    }) as never;
    window.planner.select('sess_sf_sales');
  });

  // Required lines never offer ✕; optional wired lines do:
  expect(await page.locator('#nf_creds button[data-credclear="username"]').count()).toBe(0);
  expect(await page.locator('#nf_creds button[data-credclear="url"]').count()).toBe(0);
  const clearTotp = page.locator('#nf_creds button[data-credclear="totp"]');
  await expect(clearTotp).toBeVisible();

  await clearTotp.click();
  await expect(page.locator('#status')).toContainText("totp cleared — this system doesn't use it");
  await expect(page.locator('#nf_creds input[data-cred="totp"]')).toHaveValue('');
  await expect(page.locator('#nf_creds input[data-cred="totp"]')).toHaveAttribute('placeholder', '(not used — type a name to wire it)');
  await expect(page.locator('#nf_creds span[title="not used by this system"]')).toHaveCount(1);
  expect(await page.locator('#nf_creds button[data-credclear="totp"]').count()).toBe(0); // nothing left to clear
});

test('a stale dev server is named, not silently downgraded', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => {
    (window as never as { PLANNER_FORCE_SERVED: boolean }).PLANNER_FORCE_SERVED = true;
    (window as never as { SERVER_STALE: boolean }).SERVER_STALE = true;
    window.planner.select('sess_sf_sales');
  });
  await expect(page.locator('#nf_creds')).toContainText('older than this page — restart it (Ctrl+C, then npm run planner)');
});

test('env names are editable when served: a rename POSTs, applies, and refusals snap back', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);

  // file:// → read-only spans, no inputs (editing needs the dev server):
  await page.evaluate(() => { window.planner.select('sess_sf_sales'); });
  expect(await page.locator('#nf_creds input[data-cred]').count()).toBe(0);

  // Served mode → every line is an input, with a fetch stub:
  await page.evaluate(() => {
    (window as never as { PLANNER_FORCE_SERVED: boolean }).PLANNER_FORCE_SERVED = true;
    (window as never as { ENV_STATUS: Record<string, boolean> }).ENV_STATUS = { SF_INSTANCE_URL: true, SF_SALES_USERNAME: false };
    (window as never as { __posts: unknown[] }).__posts = [];
    window.fetch = ((_url: string, opts?: { body?: string }) => {
      (window as never as { __posts: unknown[] }).__posts.push(JSON.parse(opts!.body!));
      const body = JSON.parse(opts!.body!) as Record<string, string>;
      if (body.usernameEnv === 'BAD NAME') {
        return Promise.resolve({ ok: false, json: () => Promise.resolve({ ok: false, error: 'usernameEnv: must be an ENV VAR NAME' }) });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          wiring: { username: body.usernameEnv, password: 'SF_SALES_PASSWORD', url: 'SF_INSTANCE_URL', kind: 'internal' },
          envstatus: { SF_INSTANCE_URL: true, [body.usernameEnv!]: true },
        }),
      });
    }) as never;
    window.planner.select('start'); window.planner.select('sess_sf_sales');
  });
  const userInput = page.locator('#nf_creds input[data-cred="username"]');
  await expect(userInput).toHaveValue('SF_SALES_USERNAME');

  // Rename to the team's existing var → POSTs, re-renders green:
  await userInput.fill('SFDC_UAT_USERNAME');
  await userInput.dispatchEvent('change');
  await expect(page.locator('#status')).toContainText("saved to personas.json — 'sales_user' username now reads SFDC_UAT_USERNAME");
  await expect(page.locator('#nf_creds input[data-cred="username"]')).toHaveValue('SFDC_UAT_USERNAME');
  await expect(page.locator('#nf_creds span[title="set in .env"]')).toHaveCount(2); // url + renamed username
  const posted = await page.evaluate(() => (window as never as { __posts: Record<string, string>[] }).__posts);
  expect(posted[0]).toEqual({ personaId: 'sales_user', usernameEnv: 'SFDC_UAT_USERNAME' });

  // A refused name reports why and snaps back to what's on disk:
  await page.locator('#nf_creds input[data-cred="username"]').fill('BAD NAME');
  await page.locator('#nf_creds input[data-cred="username"]').dispatchEvent('change');
  await expect(page.locator('#status')).toContainText('env name NOT saved — usernameEnv: must be an ENV VAR NAME');
  await expect(page.locator('#nf_creds input[data-cred="username"]')).toHaveValue('SFDC_UAT_USERNAME');
});

test('every built-in graph renders whole: all nodes drawn, laid out, never stacked (the lead_to_customer regression)', async ({ page }) => {
  const libraryIds = await page.evaluate(() => Object.keys((window as never as { GRAPH_LIBRARY: Record<string, unknown> }).GRAPH_LIBRARY));
  expect(libraryIds.length).toBeGreaterThanOrEqual(3);

  for (const id of libraryIds) {
    await page.evaluate((gid) => { window.planner.openFromLibrary(`lib:${gid}`); }, id);
    const state = await page.evaluate((gid) => {
      const lib = (window as never as { GRAPH_LIBRARY: Record<string, { nodes: unknown[]; edges: unknown[] }> }).GRAPH_LIBRARY[gid];
      const cyt = window.cy as {
        nodes(): { length: number; map<T>(f: (n: { position(): { x: number; y: number } }) => T): T[] };
        edges(): { length: number };
      };
      return {
        wantNodes: lib!.nodes.length, gotNodes: cyt.nodes().length,
        wantEdges: lib!.edges.length, gotEdges: cyt.edges().length,
        positions: cyt.nodes().map((n) => `${Math.round(n.position().x)},${Math.round(n.position().y)}`),
      };
    }, id);
    expect(state.gotNodes, `${id}: every node drawn`).toBe(state.wantNodes);
    expect(state.gotEdges, `${id}: every edge drawn`).toBe(state.wantEdges);
    // No stacked cluster: no two nodes may share a position after render.
    expect(new Set(state.positions).size, `${id}: nodes must not stack`).toBe(state.positions.length);
  }
});

test('check: badge counts issues live; the panel lists must-fix + to-finish with hints; rows jump to the culprit', async ({ page }) => {
  // A draft-ish graph: unknown persona, nothing captured, no URLs.
  const g = goodGraphV2() as unknown as { actors: Record<string, string> };
  g.actors.approver = 'ghost_user';
  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);

  // The badge already knows, before the panel is ever opened:
  await expect(page.locator('#b_check')).not.toHaveText('check ✓');
  const issues = await page.evaluate(() => window.planner.issues());
  expect(issues.errors).toEqual([]); // valid, just unfinished
  const kinds = issues.gaps.map((x) => x.kind);
  expect(kinds).toContain('role_unbound'); // ghost_user vs the built-in roster
  expect(kinds).toContain('not_captured');

  await page.locator('#b_check').click();
  await expect(page.locator('#issues')).toBeVisible();
  await expect(page.locator('#iss_list')).toContainText('to finish');
  await expect(page.locator('#iss_list')).toContainText("Role 'approver' is bound to persona 'ghost_user'");
  await expect(page.locator('#iss_list')).toContainText('has no captured steps');

  // Clicking a row selects the offending node:
  await page.locator('#iss_list .iss_row', { hasText: "Session 'Salesforce · submitter'" }).first().click();
  await expect(page.locator('#nf_id')).toHaveText('sess_sf_sales');

  // Break the graph → a MUST FIX section appears:
  await page.evaluate(() => window.planner.get().edges.push({ id: 'bad', from: 'submit_x', to: 'expense', type: 'next' }));
  await page.locator('#b_check').click(); await page.locator('#b_check').click(); // close + reopen re-renders
  await expect(page.locator('#iss_list')).toContainText('must fix');
  await expect(page.locator('#iss_list')).toContainText("unknown node");
  await page.locator('#iss_close').click();
  await expect(page.locator('#issues')).toBeHidden();
});

test('check: a finished graph earns the green line and the ✓ badge', async ({ page }) => {
  const done = {
    schema: 'process-graph/2', id: 'tiny_done', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
    actors: { operator: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      {
        id: 'sess_operator', type: 'session', label: 'Salesforce · operator', system: 'sf', actor: 'operator',
        url: '/lightning/page', steps: { status: 'captured', journeyId: 'tiny' },
      },
      { id: 'rec', type: 'data', label: 'Record', expects: [{ id: 'seen', kind: 'ui.text', value: 'Saved' }] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess_operator', type: 'login_as' },
      { id: 'e2', from: 'sess_operator', to: 'rec', type: 'does', data: { catalog: 'rec.save' } },
      { id: 'e3', from: 'sess_operator', to: 'end', type: 'next' },
    ],
  };
  await page.evaluate((doc) => window.planner.load(doc), done as unknown as Record<string, unknown>);
  await expect(page.locator('#b_check')).toHaveText('check ✓');
  await page.locator('#b_check').click();
  await expect(page.locator('#iss_list')).toContainText('valid and complete');
});

test('hover tips: every node type explains itself in one sentence', async ({ page }) => {
  await page.evaluate(() => window.planner.newGraph(true));
  await page.evaluate(() => { window.planner.addTyped('db'); window.planner.addTyped('logger'); window.planner.addTyped('api'); window.planner.addTyped('session'); });

  const tips = await page.evaluate(() => ({
    db: window.planner.tipFor('db_1'),
    log: window.planner.tipFor('log_1'),
    api: window.planner.tipFor('api_1'),
    sess: window.planner.tipFor('sess_1'),
    start: window.planner.tipFor('start'),
  }));
  expect(tips.db).toContain('NOT queryable');
  expect(tips.db).toContain('verify via the app API or a log system');
  expect(tips.log).toContain('log.traffic');
  expect(tips.api).toContain('integration hop');
  expect(tips.sess).toContain('capture command');
  expect(tips.start).toContain('every run begins here');

  // Edge tips explain the relation, including unbound does edges:
  await page.evaluate(() => window.planner.connect('sess_1', 'db_1', 'does'));
  const edgeId = await page.evaluate(() => (window.planner.get().edges[0] as { id: string }).id);
  expect(await page.evaluate((id) => window.planner.tipFor(id), edgeId)).toContain('unbound: name or capture it');

  // The tooltip element exists and starts hidden:
  await expect(page.locator('#cytip')).toBeHidden();
});

test('readiness cockpit: status bar counts captured/bound/checks; ✓rec marks captured sessions; does edges get name suggestions', async ({ page }) => {
  const g = goodGraphV2() as unknown as {
    nodes: { id: string; type: string; steps?: Record<string, unknown>; label?: string }[];
    edges: { id: string; type: string; data?: Record<string, unknown>; label?: string }[];
  };
  // One captured session; one does edge stripped of its catalog binding:
  g.nodes.find((n) => n.id === 'sess_sf_sales')!.steps = { status: 'captured', journeyId: 'expense_v2' };
  const unbound = g.edges.find((e) => e.id === 'e2')!;
  delete unbound.data!.catalog;
  unbound.label = 'submit expense';

  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);

  // One glance = what's left:
  expect(await page.evaluate(() => window.planner.readiness())).toBe('captured 1/3 · bound 2/3 · checks 2');
  await expect(page.locator('#status')).toContainText('captured 1/3');
  await expect(page.locator('#status')).toContainText('bound 2/3');

  // Captured sessions read ✓rec instead of the record hint:
  const labels = await page.evaluate(() =>
    (window.cy as { nodes(): { map<T>(f: (n: { data(k: string): string }) => T): T[] } }).nodes().map((n) => n.data('label')),
  );
  expect(labels.find((l) => l.includes('submitter'))).toContain('✓rec');

  // The convention suggestion: <target-noun>.<edge-verb>, offered as placeholder:
  expect(await page.evaluate(() => window.planner.suggestCatalog('e2'))).toBe('expense_record.submit_expense');
  await page.evaluate(() => { window.planner.select('e2'); });
  await expect(page.locator('#ef_catalog')).toHaveAttribute('placeholder', 'suggest: expense_record.submit_expense');
});

test('check rows stay readable in the card: target/value get real width on their own line', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);
  await page.evaluate(() => window.planner.select('expense'));
  // The squeeze regression: with kind+ms+✕ on one line and target/value on
  // the next, each input must hold real content (was ~35px, unusable).
  const widths = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#xf_list input[data-f="target"], #xf_list input[data-f="value"]'))
      .map((el) => el.getBoundingClientRect().width),
  );
  expect(widths.length).toBeGreaterThanOrEqual(4); // 2 checks × target+value
  for (const w of widths) expect(w).toBeGreaterThan(90);
  // The snapshot slot explains it fills itself from runs:
  await expect(page.locator('#row_snapshot')).toContainText('every run embeds its screenshot here automatically');
});

test('draft oracles: badge shows, confirm clears it; api timeout edits write timeoutMs', async ({ page }) => {
  const g = goodGraphV2() as unknown as {
    nodes: { id: string; expects?: Record<string, unknown>[] }[];
  };
  const expense = g.nodes.find((n) => n.id === 'expense')!;
  expense.expects!.push({
    id: 'guessed', kind: 'api.record_exists', target: 'Expense__c',
    draft: true, note: 'draft from capture — confirm once (planner: untick draft)',
  });
  await page.evaluate((doc) => window.planner.load(doc), g as unknown as Record<string, unknown>);
  await page.evaluate(() => { window.planner.select('expense'); });

  // The draft badge is visible on the guessed row:
  const badge = page.locator('#xf_list button[data-f="confirm"]');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('draft?');

  // Confirming clears draft + the machine note — the confirm-once idiom:
  await badge.click();
  const confirmed = await page.evaluate(() => {
    const n = window.planner.get().nodes.find((x) => (x as { id: string }).id === 'expense') as {
      expects: Record<string, unknown>[];
    };
    return n.expects.find((x) => x.id === 'guessed')!;
  });
  expect(confirmed.draft).toBeUndefined();
  expect(confirmed.note).toBeUndefined();
  await expect(page.locator('#xf_list button[data-f="confirm"]')).toHaveCount(0);

  // api.* rows expose the oracle budget; editing writes an integer timeoutMs:
  const timeouts = page.locator('#xf_list input[data-f="timeoutMs"]');
  await expect(timeouts.first()).toBeVisible();
  const idx = await timeouts.last().getAttribute('data-i');
  await timeouts.last().fill('120000');
  await timeouts.last().dispatchEvent('change');
  const ms = await page.evaluate((i) => {
    const n = window.planner.get().nodes.find((x) => (x as { id: string }).id === 'expense') as {
      expects: Record<string, unknown>[];
    };
    return n.expects[Number(i)]!.timeoutMs;
  }, idx);
  expect(ms).toBe(120000);
});

test('▶ test menu: spec + run commands derive from the graph id and copy with guidance', async ({ page }) => {
  await page.evaluate((g) => window.planner.load(g), goodGraphV2() as unknown as Record<string, unknown>);

  // API surface first — the exact commands, no clipboard needed to read them:
  expect(await page.evaluate(() => window.planner.testCommands())).toEqual({
    spec: 'GRAPH_SPEC=expense_to_siebel npm run graph:spec',
    run: 'npm run test:e2e -- tests/e2e/expense_to_siebel.journey.spec.ts',
  });

  // The UI path: picking an entry resets the select and surfaces the full command.
  const pick = (v: string) =>
    page.evaluate((val) => {
      const el = document.getElementById('f_test') as HTMLSelectElement;
      el.value = val;
      el.dispatchEvent(new Event('change'));
    }, v);

  await pick('spec');
  await expect(page.locator('#status')).toContainText('GRAPH_SPEC=expense_to_siebel npm run graph:spec');
  await expect(page.locator('#status')).toContainText('writes tests/e2e/expense_to_siebel.journey.spec.ts');

  await pick('run');
  await expect(page.locator('#status')).toContainText('npm run test:e2e -- tests/e2e/expense_to_siebel.journey.spec.ts');
  await expect(page.locator('#status')).toContainText('repaints this graph');
  expect(await page.evaluate(() => (document.getElementById('f_test') as HTMLSelectElement).value)).toBe('');

  // No id yet → guidance, not a broken command (G is live via get()):
  await page.evaluate(() => { (window.planner.get() as { id?: string }).id = ''; });
  expect(await page.evaluate(() => window.planner.testCommands())).toBeNull();
  await pick('spec');
  await expect(page.locator('#status')).toContainText('give the graph an id first');
});
