/**
 * S3.1 — the journey script planner's SHELL, driven over file:// exactly as a
 * user double-clicking tools/journey-planner.html would get it.
 *
 * What this pins is the contract sprints 3.2 (canvas) and 3.3 (sheets) build
 * on: the page boots with every shared module inlined, the projection
 * (`P2.view.lines`) agrees with the walker the runner uses, every mutation
 * goes through an op that leaves a VALID graph behind, and `window.planner`
 * still answers to every name docs/PLANNER-FEATURE-PARITY.md §8 lists — that
 * last assertion reads the parity table itself, so the table and the code
 * cannot drift apart quietly.
 *
 * The window type is LOCAL (never `declare global`): tests/harness/planner.spec.ts
 * already declares `window.planner` with the v1 shape, and two global
 * declarations of one property do not merge.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { legacyGraphV1, goodGraphV2 } from '../helpers/sampleGraph';

const ROOT = path.resolve(__dirname, '../..');
const PLANNER = pathToFileURL(path.join(ROOT, 'tools/journey-planner.html')).href;

interface Port { io: string; draft: boolean; reason: string }
interface StepLine {
  edgeId: string; kind: string; verb: string; record: string; recordId: string;
  catalog: string; port: Port | null; checks: { nodeId: string; expect: Record<string, unknown> }[];
}
interface Lines {
  sessions: { id: string; stranded: boolean; steps: StepLine[] }[];
  records: { name: string; sobject: string; producers: string[]; consumers: string[] }[];
}
interface OpResult { ok: boolean; errors: string[]; id?: string }
interface Doc {
  schema: string; id: string; actors: Record<string, string>;
  nodes: { id: string; type: string; label: string; sobject?: string; expects?: Record<string, unknown>[] }[];
  edges: { id: string; from: string; to: string; type: string; label?: string; data?: Record<string, unknown> }[];
}
interface V2Window {
  planner: {
    version: string;
    load(g: unknown): { ok: boolean; errors: string[] };
    export(): { json: string; ok: boolean; errors: string[] };
    get(): Doc;
    validate(): { ok: boolean; errors: string[] };
    script(): { text: string; dropped: string[] };
    openFromLibrary(ref: string): boolean;
    newGraph(force?: boolean): boolean;
    setMode(m: string): void;
    undo(): OpResult;
    undoDepth(): number;
    readiness(): string;
  } & Record<string, unknown>;
  P2: {
    state: { doc: Doc; sel: { kind: string; id: string }; cardOpen: boolean };
    view: {
      lines(doc: Doc): Lines;
      checks(doc: Doc, opts?: unknown): { mustFix: { text: string; at: { kind: string; id: string } }[] };
    };
    ops: Record<string, ((...args: unknown[]) => OpResult) | undefined>;
    lib: { compose(): { runOrder(g: Doc): { chain: string[]; steps: { sessionId: string; edgeId: string }[] } } };
  };
  GRAPH_LIBRARY: Record<string, Doc>;
  ProcessGraphSchema: unknown; ProcessGraphGaps: unknown; ProcessGraphCompose: unknown;
  ProcessGraphInfer: unknown; ProcessGraphUpgrade: unknown; ProcessGraphScript: unknown;
  cytoscape: unknown;
}
test.beforeEach(async ({ page }) => {
  await page.goto(PLANNER);
  // ~1.2 MB of inline script: under parallel worker load 30s is honest.
  await page.waitForFunction(() => !!(window as unknown as V2Window).planner, undefined, { timeout: 30_000 });
});

test('boots self-contained: every shared module inlined, no page errors, a valid document open', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(PLANNER);
  await page.waitForFunction(() => !!(window as unknown as V2Window).planner, undefined, { timeout: 30_000 });

  expect(await page.evaluate(() => (window as unknown as V2Window).planner.version)).toBe('planner/2');
  const globals = await page.evaluate(() => {
    const w = window as unknown as V2Window;
    return {
      schema: typeof w.ProcessGraphSchema, gaps: typeof w.ProcessGraphGaps,
      compose: typeof w.ProcessGraphCompose, infer: typeof w.ProcessGraphInfer,
      upgrade: typeof w.ProcessGraphUpgrade, script: typeof w.ProcessGraphScript,
      cytoscape: typeof w.cytoscape,
    };
  });
  expect(globals).toEqual({
    schema: 'object', gaps: 'object', compose: 'object', infer: 'object',
    upgrade: 'object', script: 'object', cytoscape: 'function',
  });
  expect(pageErrors).toEqual([]);
  expect(await page.evaluate(() => (window as unknown as V2Window).planner.validate())).toEqual({ ok: true, errors: [] });
  // The script codec answers on the PAGE, not only in node.
  expect(await page.evaluate(() => (window as unknown as V2Window).planner.script().text)).toContain('as ');
});

test('every shipped graph loads, and lines() is runOrder + declaration order', async ({ page }) => {
  const refs = await page.evaluate(() => Object.keys((window as unknown as V2Window).GRAPH_LIBRARY).sort());
  expect(refs.length).toBeGreaterThan(2);
  for (const ref of refs) {
    const out = await page.evaluate((r: string) => {
      const w = window as unknown as V2Window;
      w.planner.openFromLibrary(r);
      const doc = w.planner.get();
      const lines = w.P2.view.lines(doc);
      const order = w.P2.lib.compose().runOrder(doc);
      return {
        ok: w.planner.validate().ok,
        sessions: lines.sessions.filter((s) => !s.stranded).map((s) => s.id),
        chain: order.chain,
        steps: lines.sessions.reduce<string[]>((acc, s) => acc.concat(s.steps.map((t) => t.edgeId)), []),
        walked: order.steps.map((s) => s.edgeId),
      };
    }, ref);
    expect(out.ok, `${ref} is valid`).toBe(true);
    expect(out.sessions, `${ref} session order`).toEqual(out.chain);
    // The walk schedules does/denied/asserts; the script shows exactly those,
    // in the same order — the line numbers ARE the run order.
    expect(out.steps, `${ref} step order`).toEqual(out.walked);
  }
});

test('editing a verb rewrites the label and the catalog in the exported graph', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const step = w.P2.view.lines(w.planner.get()).sessions[0]!.steps[0]!;
    const res = w.P2.ops.setStepField!(step.edgeId, 'verb', 'file');
    const edge = w.planner.get().edges.find((e) => e.id === step.edgeId)!;
    return { res, label: edge.label, catalog: edge.data?.catalog, before: step.catalog };
  }, goodGraphV2());
  expect(out.res.ok).toBe(true);
  expect(out.before).toBe('expense.submit');
  expect(out.label).toBe('file expense record');
  expect(out.catalog).toBe('expense.file');
});

test('typing a record name creates ONE data node, shared by every step that names it', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const lines = w.P2.view.lines(w.planner.get());
    const a = lines.sessions[0]!.steps[0]!.edgeId;
    const b = lines.sessions[1]!.steps[0]!.edgeId;
    const r1 = w.P2.ops.setStepField!(a, 'record', 'Invoice');
    const r2 = w.P2.ops.setStepField!(b, 'record', 'Invoice');
    const doc = w.planner.get();
    return {
      ok: r1.ok && r2.ok,
      valid: w.planner.validate().ok,
      dataNodes: doc.nodes.filter((n) => n.type === 'data').map((n) => ({ id: n.id, label: n.label, sobject: n.sobject })),
      sameTarget: doc.edges.find((e) => e.id === a)!.to === doc.edges.find((e) => e.id === b)!.to,
    };
  }, goodGraphV2());
  expect(out.ok).toBe(true);
  expect(out.valid).toBe(true);
  expect(out.sameTarget).toBe(true);
  // ONE new node for the name, with its SObject guessed once; the old record
  // survives because other steps still name it (an orphan would be pruned).
  expect(out.dataNodes).toEqual([
    { id: 'expense', label: 'Expense record', sobject: 'Expense__c' },
    { id: 'invoice', label: 'Invoice', sobject: 'Invoice__c' },
  ]);
});

test('an unset port shows the inferred draft, and confirming writes data.io', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    const doc = g as Doc;
    delete doc.edges.find((e) => e.id === 'e7')!.data!.io;
    w.planner.load(doc);
    const before = w.P2.view.lines(w.planner.get()).sessions[2]!.steps[0]!;
    const res = w.P2.ops.confirmPort!('e7');
    const edge = w.planner.get().edges.find((e) => e.id === 'e7')!;
    const after = w.P2.view.lines(w.planner.get()).sessions[2]!.steps[0]!;
    return { before: before.port, res, io: edge.data?.io, draft: edge.data?.ioDraft, after: after.port };
  }, goodGraphV2());
  expect(out.before?.io).toBe('consumes');
  expect(out.before?.draft).toBe(true);
  expect(out.res.ok).toBe(true);
  expect(out.io).toBe('consumes');
  expect(out.draft).toBeUndefined();
  expect(out.after?.draft).toBe(false);
});

test('adding a session appends a login_as link; reordering rewires the chain, valid at every step', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const valid: boolean[] = [];
    const add = w.P2.ops.addSession!('Fraud Analyst', 'sf', '/lightning/o/Case/list');
    valid.push(w.planner.validate().ok);
    const chainAfterAdd = w.P2.lib.compose().runOrder(w.planner.get()).chain;
    const up1 = w.P2.ops.moveSession!(add.id, 'up');
    valid.push(w.planner.validate().ok);
    const up2 = w.P2.ops.moveSession!(add.id, 'up');
    valid.push(w.planner.validate().ok);
    const doc = w.planner.get();
    return {
      addOk: add.ok, up1: up1.ok, up2: up2.ok, valid, id: add.id, chainAfterAdd,
      chainNow: w.P2.lib.compose().runOrder(doc).chain,
      stranded: w.P2.view.lines(doc).sessions.filter((s) => s.stranded).length,
      logins: doc.edges.filter((e) => e.type === 'login_as').length,
      actor: doc.actors.fraud_analyst,
    };
  }, goodGraphV2());
  expect([out.addOk, out.up1, out.up2]).toEqual([true, true, true]);
  expect(out.valid).toEqual([true, true, true]);
  expect(out.actor).toBe('fraud_analyst');
  expect(out.chainAfterAdd[3]).toBe(out.id);
  expect(out.chainNow[1]).toBe(out.id);
  expect(out.chainNow).toHaveLength(4);
  expect(out.logins).toBe(4);
  expect(out.stranded).toBe(0);
});

test('the check editor writes an expects entry scoped `after` the step catalog', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const step = w.P2.view.lines(w.planner.get()).sessions[0]!.steps[0]!;
    const added = w.P2.ops.addCheck!(step.edgeId);
    const nodeId = step.recordId;
    const fresh = w.planner.get().nodes.find((n) => n.id === nodeId)!.expects!.find((e) => e.id === added.id)!;
    const edited = w.P2.ops.setCheck!(nodeId, added.id, 'value', 'was submitted');
    const after = w.planner.get().nodes.find((n) => n.id === nodeId)!.expects!.find((e) => e.id === added.id)!;
    const line = w.P2.view.lines(w.planner.get()).sessions[0]!.steps[0]!;
    return {
      added, edited, after: fresh.after, draft: fresh.draft,
      confirmed: after.draft, value: after.value,
      onLine: line.checks.map((c) => c.expect.id),
    };
  }, goodGraphV2());
  expect(out.added.ok).toBe(true);
  expect(out.after).toBe('expense.submit');
  expect(out.draft).toBe(true);          // a new check is a guess…
  expect(out.edited.ok).toBe(true);
  expect(out.confirmed).toBeUndefined(); // …and editing it IS confirming it
  expect(out.value).toBe('was submitted');
  expect(out.onLine).toContain(out.added.id);
});

test('undo restores the previous document, one op at a time', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const before = JSON.stringify(w.planner.get());
    const step = w.P2.view.lines(w.planner.get()).sessions[0]!.steps[0]!;
    w.P2.ops.setStepField!(step.edgeId, 'verb', 'file');
    w.P2.ops.addSession!('Fraud Analyst', 'sf', '');
    const depth = w.planner.undoDepth();
    w.planner.undo();
    w.planner.undo();
    return { before, depth, after: JSON.stringify(w.planner.get()), depthNow: w.planner.undoDepth() };
  }, goodGraphV2());
  expect(out.depth).toBe(2);
  expect(out.after).toBe(out.before);
  expect(out.depthNow).toBe(0);
});

test('Fix next selects the line the first must-fix lives on', async ({ page }) => {
  // A valid DOCUMENT with a broken data flow: the first touch consumes a
  // record nothing has produced. dataflowHealth is a must-fix referee.
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    const doc = g as Doc;
    doc.edges.find((e) => e.id === 'e2')!.data!.io = 'consumes';
    w.planner.load(doc);
    const checks = w.P2.view.checks(w.planner.get());
    (document.getElementById('b_fixnext') as HTMLButtonElement).click();
    return { mustFix: checks.mustFix.map((m) => m.text), sel: w.P2.state.sel, card: w.P2.state.cardOpen };
  }, goodGraphV2());
  expect(out.mustFix.length).toBeGreaterThan(0);
  expect(out.mustFix[0]).toContain('nothing defines it before this point');
  expect(out.sel).toEqual({ kind: 'step', id: 'e2' });
  expect(out.card).toBe(true);
});

test('export() is exactly get(), and a v1 file opens as v2 through the same door', async ({ page }) => {
  const round = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    const ex = w.planner.export();
    return { same: JSON.stringify(w.planner.get()) === JSON.stringify(JSON.parse(ex.json)), ok: ex.ok };
  }, goodGraphV2());
  expect(round).toEqual({ same: true, ok: true });

  const upgraded = await page.evaluate((v1: unknown) => {
    const w = window as unknown as V2Window;
    const res = w.planner.load(v1);
    const doc = w.planner.get();
    return {
      res, schema: doc.schema,
      sessions: doc.nodes.filter((n) => n.type === 'session').length,
      lines: w.P2.view.lines(doc).sessions.length,
      valid: w.planner.validate().ok,
    };
  }, legacyGraphV1());
  expect(upgraded.res.ok).toBe(true);
  expect(upgraded.schema).toBe('process-graph/2');
  expect(upgraded.valid).toBe(true);
  expect(upgraded.sessions).toBeGreaterThan(0);
  expect(upgraded.lines).toBe(upgraded.sessions);
});

test('view mode hides every editing control and leaves the script readable', async ({ page }) => {
  await expect(page.locator('#b_addsession')).toBeVisible();
  await expect(page.locator('#b_save')).toBeVisible();
  await page.evaluate(() => { (window as unknown as V2Window).planner.setMode('view'); });
  await expect(page.locator('body')).toHaveClass(/view/);
  await expect(page.locator('#b_addsession')).toBeHidden();
  await expect(page.locator('#b_save')).toBeHidden();
  await expect(page.locator('#b_export')).toBeVisible();
  await expect(page.locator('.line.session').first()).toBeVisible();
  await page.evaluate(() => { (window as unknown as V2Window).planner.setMode('edit'); });
  await expect(page.locator('#b_addsession')).toBeVisible();
});

test('the script pane renders one line per session and per step, numbered in run order', async ({ page }) => {
  await page.evaluate((g: unknown) => { (window as unknown as V2Window).planner.load(g); }, goodGraphV2());
  await expect(page.locator('.line.session')).toHaveCount(3);
  await expect(page.locator('.line.step')).toHaveCount(4);
  await expect(page.locator('.line.step.denied')).toHaveCount(1);
  await expect(page.locator('.line.session .num').first()).toHaveText('1');
  await expect(page.locator('.line.step .num').first()).toHaveText('1.1');
  // The port pill carries the direction; the catalog rides beside it.
  await expect(page.locator('.line.step').first().locator('.pill.produces')).toContainText('produces');
  await expect(page.locator('.line.step').first()).toContainText('expense.submit');
});

test('typing the script turns a blank graph into a valid one — the README Path A, by hand', async ({ page }) => {
  // The whole point of the rewrite (review §2: ≈70 actions → ≈18). Driven
  // through the DOM, not the ops, because the two bugs this caught — a
  // must-not line deriving the capability from the word "must", and the
  // closing `next` edge landing in the middle of the file — were both
  // invisible from the op layer.
  const fill = async (selector: string, value: string, nth = 0) => {
    const box = page.locator(selector).nth(nth);
    await box.fill(value);
    await box.blur();
  };
  await page.evaluate(() => { (window as unknown as V2Window).planner.newGraph(true); });
  await fill('.line.session input[data-f="role"]', 'Client Associate');
  await fill('.line.session input[data-f="url"]', '/lightning/o/Account/list');
  await page.locator('.addrow button:has-text("+ step")').first().click();
  await fill('.line.step input[data-f="verb"]', 'create');
  await fill('.line.step input[data-f="record"]', 'Customer');
  await page.locator('.line.step .pill[data-act="confirmio"]').first().click();
  await page.locator('.addrow button:has-text("+ must not")').first().click();
  await fill('.line.step.denied input[data-f="verb"]', 'delete');
  await fill('.line.step.denied input[data-f="record"]', 'Customer');

  const out = await page.evaluate(() => {
    const w = window as unknown as V2Window;
    const doc = w.planner.get();
    return {
      valid: w.planner.validate(),
      actors: doc.actors,
      sobject: doc.nodes.find((n) => n.type === 'data')!.sobject,
      steps: doc.edges.filter((e) => e.type === 'does' || e.type === 'denied')
        .map((e) => [e.type, e.label, e.data?.catalog ?? e.data?.capability, e.data?.io ?? '']),
      lastEdge: doc.edges[doc.edges.length - 1]!.type,
      script: w.planner.script().text,
    };
  });
  expect(out.valid).toEqual({ ok: true, errors: [] });
  expect(out.actors).toEqual({ client_associate: 'client_associate' });
  expect(out.sobject).toBe('Account');            // guessed from the record name
  expect(out.steps).toEqual([
    ['does', 'create customer', 'customer.create', 'produces'],
    // the must-not line's capability is <record>.<verb>, not <record>.must
    ['denied', 'must not delete customer', 'customer.delete', ''],
  ]);
  expect(out.lastEdge).toBe('next');              // the closing edge stays last
  expect(out.script).toContain('as client_associate at /lightning/o/Account/list');
  expect(out.script).toContain('create Customer (Account) -> produces');
  expect(out.script).toContain('must not delete Customer');
});

test('window.planner answers to every name the parity table §8 lists', async ({ page }) => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs/PLANNER-FEATURE-PARITY.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 8.'), doc.indexOf('## 9.'));
  const names = [...new Set(
    [...section.matchAll(/`([a-zA-Z]+)(?:\([^)]*\))?`/g)]
      .map((m) => m[1]!)
      .filter((n) => n !== 'window' && n !== 'planner' && n !== 'kept'),
  )];
  expect(names.length).toBeGreaterThan(30);

  const missing = await page.evaluate((list: string[]) => {
    const api = (window as unknown as V2Window).planner as Record<string, unknown>;
    return list.filter((n) => api[n] === undefined);
  }, names);
  expect(missing, 'names in PLANNER-FEATURE-PARITY §8 with no window.planner member').toEqual([]);
});

test('the record ledger and the readiness line read the document, not a side index', async ({ page }) => {
  const out = await page.evaluate((g: unknown) => {
    const w = window as unknown as V2Window;
    w.planner.load(g);
    return {
      records: w.P2.view.lines(w.planner.get()).records,
      readiness: w.planner.readiness(),
    };
  }, goodGraphV2());
  expect(out.records).toHaveLength(1);
  expect(out.records[0]!.name).toBe('Expense record');
  expect(out.records[0]!.sobject).toBe('Expense__c');
  expect(out.records[0]!.producers).toEqual(['submitter']);
  expect(out.records[0]!.consumers).toEqual(['approver', 'siebel_approver']);
  expect(out.readiness).toBe('captured 0/3 · bound 3/3 · checks 2');
});
