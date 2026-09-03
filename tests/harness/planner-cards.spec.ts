/**
 * S3.4 — the NODE CARD, and the port of the card half of the retired
 * planner's `tests/harness/planner.spec.ts` (deleted in sprint 4.1).
 *
 * v1 kept every setting in one panel with four unlabelled inputs per check
 * (`xf_list`) and a `nf_type` dropdown that could turn a session into a
 * database. v2 has three cards — session / step / graph — each showing only
 * what its kind uses, and the rows this spec pins are the parity §4 and §5
 * entries S3.4 closed:
 *
 *   nf_snapshot            run evidence + a manual attach (ops.setSnapshot)
 *   xf_list · lastResult   the pass/fail dot on the check pill and the card
 *   nf_queryable/…able     the db / logger form, created FROM the check editor
 *   nf_method · nf_path    the api hop's endpoint
 *   handoff                "replicated to →" on the step card
 *   nf_notes               a notes field on every card (ops.setNotes)
 *   nf_steps_status …      steps status / journey id / planned ms, read-only
 *
 * Coverage map for the rest of the OLD suite, which sprint 4.1 deleted after
 * checking every behaviour it pinned lands somewhere here (the same map is in
 * docs/PLANNER-FEATURE-PARITY.md §9):
 *   planner-group.spec.ts        → planner-canvas.spec.ts (box select, grip,
 *                                  group delete, single-select cards)
 *   planner-import-cases.spec.ts → planner-sheets.spec.ts (the ADO wizard,
 *                                  save-to-project, personas)
 *   planner-compose.spec.ts      → planner-compose.spec.ts (splice, not island)
 *   planner-order-health.spec.ts → planner-order-health.spec.ts
 *   planner-projects.spec.ts     → planner-projects.spec.ts
 *   the rest of planner.spec.ts  → planner-shell.spec.ts
 *
 * The window type is LOCAL (never `declare global`): each planner spec types
 * only the slice of `window.planner` it drives.
 */
import { test, expect, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { goodGraphV2 } from '../helpers/sampleGraph';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/planner.html')).href;

interface Expect_ {
  id: string; kind: string; target?: string; value?: string; after?: string;
  draft?: boolean; timeoutMs?: number; pollMs?: number;
  lastResult?: { status: string; at: string; message?: string };
}
interface DocNode {
  id: string; type: string; label?: string; notes?: string; sobject?: string; external?: boolean; url?: string;
  queryable?: boolean; searchable?: boolean; endpoint?: { method?: string; path?: string };
  snapshot?: { status: string; ref?: string; capturedAt?: string };
  steps?: { status: string; journeyId?: string; stepIndexes?: number[] };
  timing?: { plannedMs?: number; capturedMeanMs?: number };
  expects?: Expect_[];
}
interface DocEdge { id: string; from: string; to: string; type: string; label?: string; data?: Record<string, unknown> }
interface Doc { id: string; title?: string; tags?: string[]; systems: Record<string, { label?: string; kind?: string; urlEnv?: string; sessionPolicy?: { maxConcurrent: number } }>; actors: Record<string, string>; nodes: DocNode[]; edges: DocEdge[] }
interface CardWindow {
  planner: {
    load(g: unknown): { ok: boolean; errors: string[] };
    get(): Doc;
    validate(): { ok: boolean; errors: string[] };
    select(id: string): void;
    applyPersonaWiring(p: string, wiring: unknown, envstatus: unknown, all?: unknown): void;
  };
  P2: {
    state: { doc: Doc; sel: { kind: string; id: string }; cardOpen: boolean; ref: string };
    ui: { select(sel: { kind: string; id: string }, open?: boolean): void; render(): void };
    ops: {
      setSnapshot(id: string, ref: string, status?: string): { ok: boolean; errors: string[] };
      setNotes(id: string, t: string): { ok: boolean; errors: string[] };
      addInfraNode(kind: string, label: string, opts?: unknown): { ok: boolean; errors: string[]; id?: string };
      setInfraField(id: string, f: string, v: unknown): { ok: boolean; errors: string[] };
      addHandoff(rec: string, label: string, opts?: unknown): { ok: boolean; errors: string[]; id?: string };
      addCheck(edge: string, kind?: string, target?: string): { ok: boolean; errors: string[] };
    };
  };
  PERSONA_IDS: string[];
  PERSONA_ENV: Record<string, Record<string, string>>;
}

const boot = async (page: Page) => {
  await page.goto(PLANNER);
  // ~1.3 MB of inline script: under parallel worker load 30s is honest.
  await page.waitForFunction(() => !!(window as unknown as CardWindow).planner, undefined, { timeout: 30_000 });
  await page.evaluate((g: unknown) => { (window as unknown as CardWindow).planner.load(g); }, goodGraphV2());
};

/** Open the card for a line, the way a human does: click the line. */
const openSession = async (page: Page, id: string) => {
  await page.evaluate((sid) => { (window as unknown as CardWindow).P2.ui.select({ kind: 'session', id: sid }, true); }, id);
  await expect(page.locator('#ncard')).toBeVisible();
};
const openStep = async (page: Page, id: string) => {
  await page.evaluate((eid) => { (window as unknown as CardWindow).P2.ui.select({ kind: 'step', id: eid }, true); }, id);
  await expect(page.locator('#ncard')).toBeVisible();
};
const doc = (page: Page) => page.evaluate(() => (window as unknown as CardWindow).planner.get());

test.beforeEach(async ({ page }) => { await boot(page); });

// ------------------------------------------------------------- session card

test('the session card shows only what a session uses, and writes every field back', async ({ page }) => {
  await openSession(page, 'sess_sf_sales');
  await expect(page.locator('#ncard_title')).toHaveText('session');
  // v1 offered `nf_type` here — changing a session into a database. Gone.
  await expect(page.locator('#insp [data-f="type"]')).toHaveCount(0);
  await expect(page.locator('#insp [data-f="role"]')).toHaveValue('submitter');
  await expect(page.locator('#insp [data-f="system"]')).toHaveValue('sf');

  await page.locator('#insp [data-f="url"]').fill('/lightning/o/Expense__c/list');
  await page.locator('#insp [data-f="url"]').blur();
  await page.locator('#insp [data-n="notes"]').fill('the submitter opens the expense list first');
  await page.locator('#insp [data-n="notes"]').blur();

  const g = await doc(page);
  const node = g.nodes.find((n) => n.id === 'sess_sf_sales')!;
  expect(node.url).toBe('/lightning/o/Expense__c/list');
  expect(node.notes).toBe('the submitter opens the expense list first');
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);
});

// S4.1 port of the `ef_auth` half of the deleted planner.spec.ts "edge form
// binds and edits the v2 relations" — parity §5: v1 selected the login_as
// edge and picked its auth from the edge form; v2 puts the picker on the
// SESSION card, and it writes the same `data.auth` on the edge into it.
test('the auth picker sits on the session card and writes the login_as edge', async ({ page }) => {
  await openSession(page, 'sess_siebel_admin');
  const auth = page.locator('#insp [data-f="auth"]');
  await expect(auth).toHaveValue('ui');                       // read off edge e6
  await expect(auth.locator('option')).toHaveCount(4);        // (from the persona) + 3
  await expect(auth.locator('option').first()).toHaveText('from the persona');

  await auth.selectOption('singleaccess');
  let g = await doc(page);
  expect(g.edges.find((e) => e.id === 'e6')!.data!.auth).toBe('singleaccess');
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);

  // The empty option means "whatever the persona declares" — it removes the
  // override rather than writing an empty auth the validator would reject.
  await auth.selectOption('');
  g = await doc(page);
  const edge = g.edges.find((e) => e.id === 'e6')!;
  expect(edge.data?.auth).toBeUndefined();
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);
});

// parity §4 `nf_steps_status` / `nf_journey` / `nf_planned` — read-only chips.
test('capture state is chips, not fields: status, journey id and planned ms cannot be typed', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as CardWindow;
    const g = w.planner.get();
    const n = g.nodes.find((x) => x.id === 'sess_sf_sales')!;
    n.steps = { status: 'captured', journeyId: 'expense_to_siebel', stepIndexes: [0, 1] };
    n.timing = { plannedMs: 30000, capturedMeanMs: 1234 };
    w.planner.load(g);
  });
  await openSession(page, 'sess_sf_sales');

  const chips = page.locator('#insp .chiprow .chip');
  await expect(chips.nth(0)).toHaveText('captured');
  await expect(page.locator('#insp .chiprow')).toContainText('expense_to_siebel');
  await expect(page.locator('#insp .chiprow')).toContainText('planned 30000ms');
  await expect(page.locator('#insp .chiprow')).toContainText('mean 1234ms');
  // Chips, never inputs — editing them by hand made the graph lie about a run.
  await expect(page.locator('#insp .chiprow input')).toHaveCount(0);
});

test('the credentials block names the .env wiring and colours the dots the server reports', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as CardWindow;
    w.PERSONA_IDS = ['sales_user'];
    w.planner.applyPersonaWiring(
      'sales_user',
      { account: 'sales_user', username: 'SF_SALES_USERNAME', password: 'SF_SALES_PASSWORD', totp: 'SF_SALES_TOTP' },
      { SF_SALES_USERNAME: true, SF_SALES_PASSWORD: false },
    );
  });
  await openSession(page, 'sess_sf_sales');

  await expect(page.locator('#insp .credrow')).toHaveCount(4);
  await expect(page.locator('#insp .credrow [data-env="username"]')).toHaveValue('SF_SALES_USERNAME');
  await expect(page.locator('#insp .credrow').nth(0).locator('.dot')).not.toHaveClass(/bad/);
  await expect(page.locator('#insp .credrow').nth(1).locator('.dot')).toHaveClass(/bad/);   // required, missing
  await expect(page.locator('#insp')).toContainText('Copy missing lines');
  // Values never appear — names only.
  await expect(page.locator('#insp')).toContainText('values live in');
});

// parity §4 `nf_snapshot` — the row S3.4 closed.
test('snapshot: a run image shows as a thumbnail, and one can be attached by hand', async ({ page }) => {
  await openSession(page, 'sess_siebel_admin');
  await expect(page.locator('#insp .snap')).toContainText('no image yet');
  await expect(page.locator('#insp .snap .shot')).toHaveCount(0);

  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  await page.locator('#insp .snap input[type=file]').setInputFiles({ name: 'evidence.png', mimeType: 'image/png', buffer: Buffer.from(png.split(',')[1]!, 'base64') });

  await expect(page.locator('#insp .snap .shot')).toHaveCount(1);
  const g = await doc(page);
  const snap = g.nodes.find((n) => n.id === 'sess_siebel_admin')!.snapshot!;
  expect(snap.ref!.startsWith('data:image/')).toBe(true);
  expect(snap.status).toBe('planned');              // attached by hand, not captured
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);

  await page.locator('#insp .snap [data-snap="clear"]').click();
  expect((await doc(page)).nodes.find((n) => n.id === 'sess_siebel_admin')!.snapshot).toBeUndefined();
});

// ---------------------------------------------------------------- step card

test('the step card carries verb, record, SObject, catalog, port override and the existing-record flag', async ({ page }) => {
  await openStep(page, 'e2');
  await expect(page.locator('#ncard_title')).toHaveText('step');
  await expect(page.locator('#insp [data-f="verb"]')).toHaveValue('submit');
  await expect(page.locator('#insp [data-f="record"]')).toHaveValue('Expense record');
  await expect(page.locator('#insp [data-f="sobject"]')).toHaveValue('Expense__c');
  await expect(page.locator('#insp [data-f="catalog"]')).toHaveValue('expense.submit');
  // The port row is the parity §5 `ef_io` override — a select, not a relation
  // dropdown: the RELATION is inferred from the endpoints (parity §5 ef_type).
  await expect(page.locator('#insp [data-f="io"]')).toHaveValue('produces');
  // Sprint 4.4: the `origin` select collapsed to one checkbox — "this record
  // already exists" (`external`), the only value a shipped graph ever used.
  const external = page.locator('#insp input[type="checkbox"][data-f="external"]');
  await expect(external).toHaveCount(1);
  await expect(external).not.toBeChecked();
  await external.check();
  expect((await doc(page)).nodes.find((n) => n.id === 'expense')!.external).toBe(true);
  await page.locator('#insp input[type="checkbox"][data-f="external"]').uncheck();
  expect((await doc(page)).nodes.find((n) => n.id === 'expense')!.external).toBeUndefined();

  await page.locator('#insp [data-f="catalog"]').fill('expense.raise');
  await page.locator('#insp [data-f="catalog"]').blur();
  const g = await doc(page);
  expect(g.edges.find((e) => e.id === 'e2')!.data!.catalog).toBe('expense.raise');
  // A rename carries the checks that were scoped `after` the old name.
  expect(g.nodes.find((n) => n.id === 'expense')!.expects!.some((x) => x.after === 'expense.raise')).toBe(true);
});

test('the must-not card names the capability, and offers no oracle editor', async ({ page }) => {
  await openStep(page, 'e3');
  await expect(page.locator('#ncard_title')).toHaveText('must not');
  await expect(page.locator('#insp [data-f="capability"]')).toHaveValue('expense.approve');
  await expect(page.locator('#insp')).not.toContainText('what proves it worked');
});

test('the check editor labels every field per kind, and writes back on change', async ({ page }) => {
  await openStep(page, 'e2');
  const row = page.locator('#insp .checkrow').first();
  await expect(row.locator('[data-c="kind"]')).toHaveValue('api.record_exists');
  // v1: four unlabelled placeholder inputs. v2 says what each one means.
  await expect(row.locator('label')).toContainText('SObject');

  await row.locator('[data-c="kind"]').selectOption('api.field_equals');
  await row.locator('[data-c="value"]').fill('Status__c=Submitted');
  await row.locator('[data-c="value"]').blur();

  const g = await doc(page);
  const x = g.nodes.find((n) => n.id === 'expense')!.expects!.find((e) => e.id === 'expense_saved')!;
  expect(x.kind).toBe('api.field_equals');
  expect(x.value).toBe('Status__c=Submitted');
  // Editing a guess IS confirming it.
  expect(x.draft).toBeUndefined();

  // The budget box only exists for the kinds that poll.
  await expect(row.locator('[data-c="timeoutMs"]')).toHaveCount(1);
  await row.locator('[data-c="timeoutMs"]').fill('45000');
  await row.locator('[data-c="timeoutMs"]').blur();
  expect((await doc(page)).nodes.find((n) => n.id === 'expense')!.expects![0]!.timeoutMs).toBe(45000);

  await row.locator('[data-c="remove"]').click();
  expect((await doc(page)).nodes.find((n) => n.id === 'expense')!.expects!.some((e) => e.id === 'expense_saved')).toBe(false);
});

// parity §4 `xf_list` … `lastResult` — the row S3.4 closed.
test('lastResult paints the check pill and the card row, with the runner\'s message', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as CardWindow;
    const g = w.planner.get();
    const rec = g.nodes.find((n) => n.id === 'expense')!;
    rec.expects![0]!.lastResult = { status: 'pass', at: '2026-09-03T09:00:00Z' };
    rec.expects![1]!.lastResult = { status: 'fail', at: '2026-09-03T09:00:01Z', message: 'Status__c was Draft' };
    w.planner.load(g);
  });

  // …on the LINE (the script pane), where a failing oracle is visible at once
  const pills = page.locator('.line.step .pill.check');
  await expect(pills.filter({ hasText: 'api.record_exists' }).locator('.rdot.ok')).toHaveCount(1);
  const bad = pills.filter({ hasText: 'api.field_equals' });
  await expect(bad.locator('.rdot.bad')).toHaveCount(1);
  await expect(bad.locator('.rdot.bad')).toHaveAttribute('title', /Status__c was Draft/);

  // …and on the card row.
  await openStep(page, 'e5');
  await expect(page.locator('#insp .checkrow .rdot.bad')).toHaveCount(1);
});

test('a draft check is amber on the line and clicking it keeps it', async ({ page }) => {
  await openStep(page, 'e5');
  await page.locator('#b_addcheck').click();
  const draft = page.locator('.line.step .pill.check.draft');
  await expect(draft).toHaveCount(1);
  await draft.click();
  await expect(page.locator('.line.step .pill.check.draft')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);
});

// -------------------------------------------------- evidence sources (S3.4)

// parity §2 `b_add` → api / db / logger, and §4 nf_queryable / nf_searchable.
test('a database is created FROM the step card, wired with a touches edge, and its flag edits', async ({ page }) => {
  await openStep(page, 'e7');
  await expect(page.locator('#insp')).toContainText('evidence sources');
  await page.locator('#f_infralabel').fill('Siebel DB');
  await page.locator('[data-infra="db"]').click();

  let g = await doc(page);
  const db = g.nodes.find((n) => n.type === 'db')!;
  expect(db.label).toBe('Siebel DB');
  expect(db.queryable).toBe(true);            // the reachable default the validator needs
  expect(g.edges.some((e) => e.type === 'touches' && e.from === 'sess_siebel_admin' && e.to === db.id)).toBe(true);
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);

  // The db.query check can now name it — v1 refused with a puzzle.
  await page.locator('#f_checkkind').selectOption('db.query');
  await page.locator('#b_addcheck').click();
  g = await doc(page);
  const check = g.nodes.find((n) => n.id === 'expense')!.expects!.find((x) => x.kind === 'db.query')!;
  expect(check.target).toBe(db.id);
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);

  // …and the target field is a PICKER over the db nodes, not free text.
  const row = page.locator('#insp .checkrow').filter({ has: page.locator('[data-c="kind"]') }).last();
  await expect(row.locator('select[data-c="target"]')).toHaveValue(db.id);

  // Unticking `queryable` says "tests cannot reach it" — which contradicts the
  // check that now targets it, so ops REFUSES the edit and says why. The flag
  // is unchanged: a refused edit never leaves half a document behind.
  await page.locator('#insp .infrarow [data-i="queryable"]').click();
  await expect(page.locator('#toast')).toContainText('not queryable');
  expect((await doc(page)).nodes.find((n) => n.type === 'db')!.queryable).toBe(true);
});

test('a log system is created the same way, and searchable is its flag', async ({ page }) => {
  await openStep(page, 'e7');
  await page.locator('#f_infralabel').fill('API gateway logs');
  await page.locator('[data-infra="logger"]').click();

  const g = await doc(page);
  const log = g.nodes.find((n) => n.type === 'logger')!;
  expect(log.label).toBe('API gateway logs');
  expect(log.searchable).toBe(true);
  await expect(page.locator('.infrarow [data-i="searchable"]')).toBeChecked();

  await page.locator('#f_checkkind').selectOption('log.traffic');
  await page.locator('#b_addcheck').click();
  const check = (await doc(page)).nodes.find((n) => n.id === 'expense')!.expects!.find((x) => x.kind === 'log.traffic')!;
  expect(check.target).toBe(log.id);
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);
});

// parity §4 `nf_method` / `nf_path` and §5 the `handoff` row.
test('replicated to → adds an api hop with method and path, and the handoff edge', async ({ page }) => {
  await openStep(page, 'e2');
  await expect(page.locator('#insp')).toContainText('replicated to');
  await page.locator('#f_hop').fill('create_customer_v2');
  await page.locator('#f_hopmethod').fill('post');
  await page.locator('#f_hoppath').fill('/v2/customers');
  await page.locator('#b_addhop').click();

  const g = await doc(page);
  const api = g.nodes.find((n) => n.type === 'api')!;
  expect(api.label).toBe('create_customer_v2');
  expect(api.endpoint).toEqual({ method: 'POST', path: '/v2/customers' });   // method upper-cased
  const hop = g.edges.find((e) => e.type === 'handoff')!;
  expect(hop.from).toBe('expense');
  expect(hop.to).toBe(api.id);
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);

  // It is listed, editable on the api row, and removable.
  await expect(page.locator('#insp .infrarow').filter({ hasText: 'create_customer_v2' }).first()).toContainText('POST /v2/customers');
  await page.locator('[data-handoff-remove]').first().click();
  expect((await doc(page)).edges.some((e) => e.type === 'handoff')).toBe(false);
});

test('notes hang off the record the step lands on (ops.setNotes)', async ({ page }) => {
  await openStep(page, 'e2');
  await page.locator('#insp [data-n="notes"]').fill('the expense id is the handle every later lane reads');
  await page.locator('#insp [data-n="notes"]').blur();
  expect((await doc(page)).nodes.find((n) => n.id === 'expense')!.notes)
    .toBe('the expense id is the handle every later lane reads');
});

// --------------------------------------------------------------- graph card

test('the graph card holds id, title, tags and the system form — not a column', async ({ page }) => {
  await page.locator('#b_graphcard').click();
  await expect(page.locator('#ncard_title')).toHaveText('graph');
  await expect(page.locator('#insp [data-f="id"]')).toHaveValue('expense_to_siebel');
  await expect(page.locator('#insp [data-f="tags"]')).toHaveValue('smoke, sod, siebel');

  // v1 asked for `gf_systems` as a JSON textarea. v2: pills that open a form.
  await expect(page.locator('#insp [data-system]')).toHaveCount(2);
  await page.locator('#insp [data-system="siebel"]').click();
  await expect(page.locator('#sysform [data-s="urlEnv"]')).toHaveValue('SIEBEL_URL');
  await expect(page.locator('#sysform [data-s="maxConcurrent"]')).toHaveValue('1');
  await page.locator('#sysform [data-s="label"]').fill('Siebel UAT');
  await page.locator('#b_sysapply').click();

  const g = await doc(page);
  expect(g.systems.siebel!.label).toBe('Siebel UAT');
  // A system label is half of every session label on that lane.
  expect(g.nodes.find((n) => n.id === 'sess_siebel_admin')!.label).toContain('Siebel UAT');
  expect(await page.evaluate(() => (window as unknown as CardWindow).planner.validate().ok)).toBe(true);
});

test('every card ends with what is open on exactly that element', async ({ page }) => {
  await openSession(page, 'sess_sf_sales');
  await expect(page.locator('#insp')).toContainText('open on this line');
  await openStep(page, 'e2');
  await expect(page.locator('#insp')).toContainText('open on this line');
  await page.locator('#b_graphcard').click();
  await expect(page.locator('#insp')).toContainText('everything open');
});

test('Esc closes the card, and view mode leaves it read-only', async ({ page }) => {
  await openSession(page, 'sess_sf_sales');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ncard')).toBeHidden();

  await page.locator('#b_mode').click();
  await openSession(page, 'sess_sf_sales');
  await expect(page.locator('#insp #b_rec')).toBeHidden();      // .editonly is off
  await expect(page.locator('#insp [data-f="role"]')).toHaveCSS('pointer-events', 'none');
});

// ===================================================================
// S4.2 — run evidence is a FILE now (src/graph/evidence.ts). The card
// resolves `snapshot.ref` two ways: over file:// it can only NAME the file;
// served, it loads it through /__evidence. The manual attach is unchanged —
// a hand-picked image is a reference, not run evidence, so it stays a data
// URL in the document (the test above pins that).
// ===================================================================

/** A graph whose session carries a run-written, file-based snapshot ref. */
const graphWithFileRef = () => {
  const g = goodGraphV2() as unknown as Doc;
  g.nodes.find((n) => n.id === 'sess_sf_sales')!.snapshot = {
    status: 'captured', ref: 'evidence/lead/run_1/sess_sf_sales.jpg', capturedAt: '2026-09-03T09:00:00Z',
  };
  return g;
};

test('file://: a file ref is NAMED, not broken — no <img>, and the card says how to see it', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as CardWindow).planner.load(g); }, graphWithFileRef());
  await openSession(page, 'sess_sf_sales');

  await expect(page.locator('#insp .snap .shot')).toHaveCount(0);   // nothing to load over file://
  await expect(page.locator('#insp .snap .reffile')).toHaveText('evidence/lead/run_1/sess_sf_sales.jpg');
  await expect(page.locator('#insp .snap')).toContainText('npm run planner');
});

test.describe('served', () => {
  let child: ChildProcess;
  let base = '';
  let tmp = '';

  test.beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-evidence-'));
    fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify({
      org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
      personas: { admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD' } },
    }));
    fs.writeFileSync(path.join(tmp, '.env'), '');
    // A project holding the graph… and its evidence, where the ref says.
    const project = path.join(tmp, 'projects', 'demo');
    fs.mkdirSync(path.join(project, 'graphs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'project.json'), JSON.stringify({ project: 'demo', team: 'demo' }));
    fs.writeFileSync(path.join(project, 'graphs', 'lead.graph.json'), JSON.stringify({ ...graphWithFileRef(), id: 'lead' }));
    const runDir = path.join(project, 'evidence', 'lead', 'run_1');
    fs.mkdirSync(runDir, { recursive: true });
    // A REAL jpeg (the shipped demo graph's own evidence) so the browser
    // decoding it is part of the assertion.
    fs.copyFileSync(
      path.join(ROOT, 'journeys/evidence/lead_to_customer/sim_mthrf41j/chk_customer.jpg'),
      path.join(runDir, 'sess_sf_sales.jpg'),
    );

    child = spawn('node', [path.resolve(ROOT, 'tools/serve-planner.mjs')], {
      env: { ...process.env, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1' },
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

  test('the snapshot loads through /__evidence, addressed by the graph\'s ref', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as CardWindow).planner, undefined, { timeout: 30_000 });
    await page.evaluate((g: unknown) => {
      const w = window as unknown as CardWindow;
      w.planner.load(g);
      w.P2.state.ref = 'demo/lead';   // the library row this document came from
    }, graphWithFileRef());
    await openSession(page, 'sess_sf_sales');

    const img = page.locator('#insp .snap .shot');
    await expect(img).toHaveCount(1);
    const src = await img.getAttribute('src');
    expect(src).toBe('/__evidence?ref=demo%2Flead&file=evidence%2Flead%2Frun_1%2Fsess_sf_sales.jpg');
    // It is not merely addressed — it decodes:
    await expect.poll(async () => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 })
      .toBeGreaterThan(0);
    await expect(page.locator('#insp .snap')).toContainText('from the last run');
  });

  test('a data-URL ref (an old graph, or a hand attach) still renders as itself', async ({ page }) => {
    await page.goto(`${base}/`);
    await page.waitForFunction(() => !!(window as unknown as CardWindow).planner, undefined, { timeout: 30_000 });
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    await page.evaluate((args: { g: unknown; png: string }) => {
      const w = window as unknown as CardWindow;
      w.planner.load(args.g);
      w.P2.state.ref = 'demo/lead';
      w.P2.ops.setSnapshot('sess_sf_sales', args.png);
    }, { g: graphWithFileRef(), png });
    await openSession(page, 'sess_sf_sales');

    const src = await page.locator('#insp .snap .shot').getAttribute('src');
    expect(src).toBe(png);   // never routed through /__evidence
  });
});
