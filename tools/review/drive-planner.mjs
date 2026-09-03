// Drives the served planner as a first-time user would (Path A from the
// README), screenshots every stage, and logs friction counters.
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'docs/review-shots';
fs.mkdirSync(OUT, { recursive: true });
const URL = 'http://127.0.0.1:8765/process-planner.html';
let shot = 0;
const notes = [];
const note = (s) => { notes.push(s); console.log('·', s); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', async (d) => { note(`native dialog: ${d.type()} "${d.message()}"`); await d.accept(d.type() === 'prompt' ? 'crm' : undefined); });
const snap = async (name) => { shot++; await page.screenshot({ path: `${OUT}/${String(shot).padStart(2, '0')}-${name}.png` }); };

await page.goto(URL);
await page.waitForFunction(() => !!window.planner, undefined, { timeout: 60_000 });
await snap('boot');
note(`toolbar controls: ${await page.locator('header button, header select').count()}`);
note(`add ▾ options: ${(await page.locator('#b_add option').allTextContents()).join(' | ')}`);
note(`edge relation options: ${(await page.locator('#ef_type option').allTextContents()).join(' | ')}`);

// open existing shipped graph to see a "finished" one
await page.selectOption('#f_library', { index: 1 }).catch(() => {});
await page.waitForTimeout(600);
await snap('open-shipped-graph');
note(`library options: ${(await page.locator('#f_library option').allTextContents()).join(' | ')}`);
// help legend
await page.click('#b_help'); await page.waitForTimeout(200); await snap('help-legend'); await page.click('#legend');

// --- Path A ---
await page.click('#b_new'); await page.waitForTimeout(300);
await snap('new-graph');
note(`after "new": meta card auto-opened = ${await page.locator('#p_meta').isVisible()}`);
await page.click('#b_graphmeta'); await page.waitForTimeout(200);
note(`clicking "graph" button then: meta card visible = ${await page.locator('#p_meta').isVisible()} (toggle — no visible pressed state)`);
if (!(await page.locator('#p_meta').isVisible())) await page.click('#b_graphmeta');
await page.waitForTimeout(200);
await snap('graph-meta-card');
note(`graph meta: systems field is raw JSON textarea = ${await page.locator('#gf_systems').inputValue()}`);
await page.fill('#gf_id', 'create_customer'); await page.fill('#gf_title', 'Create a customer');
await page.click('#b_meta_apply'); await page.waitForTimeout(200);

// personas
await page.selectOption('#b_add', '__personas'); await page.waitForTimeout(300);
await snap('personas-dialog');
await page.fill('#pp_paste', 'Client Associate');
await page.waitForTimeout(300); await snap('personas-pasted');
await page.click('#pp_apply'); await page.waitForTimeout(600);
await snap('personas-applied');
note(`personas result: ${(await page.locator('#pp_result').innerText()).slice(0, 300)}`);
await page.click('#pp_close');

// session
await page.selectOption('#b_add', 'session'); await page.waitForTimeout(400);
await snap('session-added-card');
note(`session card front rows: ${(await page.locator('#np_main .field label').allTextContents()).join(' | ')}`);
await page.click('#nf_details summary'); await page.waitForTimeout(200);
await snap('session-card-extra');
note(`session card extra rows: ${(await page.locator('#np_extra .field label').allTextContents()).join(' | ')}`);
const sysOpts = await page.locator('#nf_system option').allTextContents();
note(`system options: ${sysOpts.join(' | ')}`);
const actorOpts = await page.locator('#nf_actor option').allTextContents();
note(`role/user options: ${actorOpts.slice(0, 8).join(' | ')}${actorOpts.length > 8 ? ' …' : ''} (${actorOpts.length})`);
await page.selectOption('#nf_system', { index: 1 }).catch((e) => note('system select failed: ' + e.message));
const g0 = await page.evaluate(() => window.planner.get());
note(`session node after add: ${JSON.stringify(g0.nodes.find((n) => n.type === 'session'))}`);
await page.selectOption('#nf_actor', { label: /client_associate/i }).catch(async () => { await page.selectOption('#nf_actor', { index: 1 }); });
await page.fill('#nf_url', '/lightning/o/Account/list');
await page.locator('#nf_url').press('Tab');
await page.waitForTimeout(200);
await snap('session-configured');

// data node
await page.selectOption('#b_add', 'data'); await page.waitForTimeout(400);
await snap('data-added-card');
note(`data card front rows: ${(await page.locator('#np_main .field label').allTextContents()).join(' | ')}`);
await page.fill('#nf_label', 'Customer record'); await page.locator('#nf_label').press('Tab');
const gd = await page.evaluate(() => window.planner.get());
const sess = gd.nodes.find((n) => n.type === 'session').id;
const data = gd.nodes.find((n) => n.type === 'data').id;
note(`ids: session=${sess} data=${data}`);
const pos = await page.evaluate(() => window.planner.get().nodes.map((n) => [n.id, n.pos]));
note(`node positions after two adds (BUG: stacked at viewport centre?): ${JSON.stringify(pos)}`);
// a user would now drag them apart — do it programmatically
await page.evaluate(([s, d]) => { window.cy.getElementById(s).position({ x: 200, y: 260 }); window.cy.getElementById(d).position({ x: 520, y: 260 }); }, [sess, data]);
await page.waitForTimeout(200); await snap('nodes-dragged-apart');

// connect start -> session via connect mode (UI)
await page.click('#b_connect'); await page.waitForTimeout(100);
await snap('connect-mode');
note(`status in connect mode: ${await page.locator('#status').innerText()}`);
const clickNode = async (id) => {
  const p = await page.evaluate((id) => { const n = window.cy.getElementById(id); const r = n.renderedPosition(); const b = document.getElementById('cy').getBoundingClientRect(); return { x: b.left + r.x, y: b.top + r.y }; }, id);
  await page.mouse.click(p.x, p.y);
};
await clickNode('start'); await clickNode(sess); await page.waitForTimeout(300);
await snap('after-connect-start-session');
let g1 = await page.evaluate(() => window.planner.get());
let e1 = g1.edges.find((e) => e.from === 'start');
note(`edge start→session created with type: ${e1?.type} (expected login_as)`);
await page.keyboard.press('Escape');
await page.evaluate((id) => window.planner.select(id), e1.id); await page.waitForTimeout(200);
await snap('edge-card-default');
await page.selectOption('#ef_type', 'login_as'); await page.waitForTimeout(200);

// session -> data
await page.click('#b_connect'); await clickNode(sess); await clickNode(data); await page.waitForTimeout(300);
await page.keyboard.press('Escape');
g1 = await page.evaluate(() => window.planner.get());
const e2 = g1.edges.find((e) => e.from === sess && e.to === data);
note(`edge session→data created with type: ${e2?.type} (needs does)`);
await page.evaluate((id) => window.planner.select(id), e2.id); await page.waitForTimeout(200);
await page.selectOption('#ef_type', 'does'); await page.waitForTimeout(200);
await snap('does-edge-card');
note(`catalog placeholder suggestion: ${await page.locator('#ef_catalog').getAttribute('placeholder')}`);
await page.fill('#ef_label', 'create customer'); await page.locator('#ef_label').press('Tab');
await page.fill('#ef_catalog', 'cust.create'); await page.locator('#ef_catalog').press('Tab');
note(`port row visible: ${await page.locator('#row_io').isVisible()}`);
await page.selectOption('#ef_io', 'produces'); await page.waitForTimeout(200);
await snap('does-edge-configured');

// checks on data node
await page.evaluate((id) => window.planner.select(id), data); await page.waitForTimeout(200);
await page.click('#xf_add'); await page.waitForTimeout(200);
await snap('check-added');
note(`check row controls: ${await page.locator('#xf_list select, #xf_list input').count()} inputs; kinds: ${(await page.locator('#xf_list select').first().locator('option').allTextContents()).join(' | ')}`);
const kindSel = page.locator('#xf_list select').first();
await kindSel.selectOption('api.record_exists').catch(() => {});
const tgt = page.locator('#xf_list input').first();
await tgt.fill('Account'); await tgt.press('Tab'); await page.waitForTimeout(200);
await snap('check-configured');

// denied edge
await page.click('#b_connect'); await clickNode(sess); await clickNode(data); await page.waitForTimeout(300);
await page.keyboard.press('Escape');
g1 = await page.evaluate(() => window.planner.get());
const e3 = g1.edges.filter((e) => e.from === sess && e.to === data).find((e) => e.id !== e2.id);
note(`second session→data edge type: ${e3?.type}`);
await page.evaluate((id) => window.planner.select(id), e3.id); await page.waitForTimeout(200);
await page.selectOption('#ef_type', 'denied'); await page.fill('#ef_capability', 'cust.delete'); await page.locator('#ef_capability').press('Tab');
await page.waitForTimeout(200);
await snap('denied-edge');

// check panel
await page.click('#b_check'); await page.waitForTimeout(400);
await snap('check-panel');
const issues = await page.evaluate(() => window.planner.issues());
note(`check: ${issues.errors.length} errors, ${issues.gaps.length} gaps → ${issues.gaps.map((g) => g.kind + '@' + g.at).join(', ')}`);
note(`errors: ${issues.errors.join(' || ')}`);
note(`status: ${await page.locator('#status').innerText()}`);
note(`readiness: ${await page.evaluate(() => window.planner.readiness())}`);

// save menu
note(`save ▾ options: ${(await page.locator('#f_save option').allTextContents()).join(' | ')}`);
note(`insert ▾ options: ${(await page.locator('#f_insert option').allTextContents()).slice(0, 6).join(' | ')}`);
note(`test ▾ options: ${(await page.locator('#f_test option').allTextContents()).join(' | ')}`);
await page.selectOption('#f_test', 'order'); await page.waitForTimeout(300);
await snap('run-order');

// export json
await page.click('#b_export'); await page.waitForTimeout(200);
const json = await page.locator('#export_out').inputValue();
fs.writeFileSync(`${OUT}/create_customer.export.json`, json);
note(`exported ${json.length} chars`);

// import cases dialog
await page.click('#b_cases'); await page.waitForTimeout(400);
await snap('import-cases-dialog');
await page.click('#ic_close');

// insert (compose) a shipped graph as island
const insOpts = await page.locator('#f_insert option').allTextContents();
const insVals = await page.locator('#f_insert option').evaluateAll((os) => os.map((o) => o.value));
const pick = insVals.find((v) => v && /lead_to_customer$/.test(v)) ?? insVals[1];
if (pick) { await page.selectOption('#f_insert', pick); await page.waitForTimeout(800); await snap('after-insert-island'); note(`inserted ${pick}: status ${await page.locator('#status').innerText()}`); }

note(`page errors: ${errors.length ? errors.join(' || ') : 'none'}`);
fs.writeFileSync(`${OUT}/notes.txt`, notes.join('\n'));
await browser.close();
