import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Feature-parity drift guard (docs/PLANNER-FEATURE-PARITY.md).
 *
 * Until sprint 4.1 this read the OLD planner and asked "is every v1 control
 * accounted for in the table?". The old planner is gone, so it now reads the
 * LIVE one — tools/planner-v2/index.html + js/*.js + tools/serve-planner.mjs
 * — and asks the same question of it: every interactive control id, every
 * New ▾ entry, every canvas event, every dev-server route and every
 * `window.planner` name must be named in the document (§10 indexes the live
 * surface; §7 the routes; §8 the API). A control that exists in code and
 * nowhere in the doc is an undocumented feature; a doc row with no valid
 * disposition is a decision nobody made.
 *
 * It also holds the retirement itself: the v1 files must stay deleted and no
 * `○` may reappear in the v2 column.
 */

const ROOT = path.resolve(__dirname, '../..');
const V2DIR = path.join(ROOT, 'tools/planner-v2');
const INDEX = fs.readFileSync(path.join(V2DIR, 'index.html'), 'utf8');
const MODULES = fs.readdirSync(path.join(V2DIR, 'js')).filter((f) => f.endsWith('.js')).sort();
const JS = Object.fromEntries(MODULES.map((f) => [f, fs.readFileSync(path.join(V2DIR, 'js', f), 'utf8')]));
const SRC = [INDEX, ...Object.values(JS)].join('\n');
const SERVER = fs.readFileSync(path.join(ROOT, 'tools/serve-planner.mjs'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/PLANNER-FEATURE-PARITY.md'), 'utf8');

const DISPOSITIONS = ['kept', 'automated', 'merged', 'dropped', 'todo', 'new'];

/** Every token the doc mentions in backticks. */
const mentioned = new Set([...DOC.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
const has = (tok: string) => mentioned.has(tok);

/** §1–§7 are the parity rows; §9's table is prose about the test suite. */
const ROWS = DOC.slice(0, DOC.indexOf('## 8.'));

test.describe('planner feature parity table', () => {
  test('every interactive control id in the planner source is named in the table', () => {
    // Markup lives in index.html AND in the modules that build cards, sheets
    // and the strip — one regex over both, controls only (a container id is
    // not a feature; the controls inside it are).
    const ids = new Set(
      [...SRC.matchAll(/<(?:button|select|input|textarea|img)\b[^>]*?\bid="([a-zA-Z_0-9]+)"/g)].map((m) => m[1]!),
    );
    expect(ids.size).toBeGreaterThan(40);
    const missing = [...ids].filter((id) => !has(id));
    expect(missing, 'controls with no mention in docs/PLANNER-FEATURE-PARITY.md').toEqual([]);
  });

  test('every New ▾ entry is in the table', () => {
    const entries = [...INDEX.matchAll(/data-new="([a-z]+)"/g)].map((m) => m[1]!);
    expect(entries.length).toBeGreaterThan(4);
    expect(entries.filter((e) => !has(e)), 'New ▾ entries with no mention').toEqual([]);
    // The menu and P2.sheets.route() must offer the same doors.
    for (const entry of entries) expect(JS['sheets.js'], `sheets.route has no case for ${entry}`).toContain(`'${entry}'`);
  });

  test('every relation the planner can write is in the table', () => {
    // v1 offered a 10-item `ef_type` dropdown; v2 INFERS the relation, so the
    // list to check is the model's own vocabulary — every edge type the
    // schema accepts is a relation this planner may put on the canvas.
    const schema = fs.readFileSync(path.join(ROOT, 'src/graph/schema.ts'), 'utf8');
    const decl = /export const EDGE_TYPES: EdgeType\[\] = \[([^\]]+)\]/.exec(schema)?.[1] ?? '';
    const types = [...decl.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(5);
    expect(types.filter((t) => !has(t)), 'relation types with no row').toEqual([]);
  });

  test('every canvas event, gesture and keyboard shortcut is in the table', () => {
    const events = new Set<string>();
    for (const m of JS['canvas.js']!.matchAll(/cy\.on\('([a-z ]+)'/g)) for (const e of m[1]!.split(' ')) events.add(e);
    expect(events.size).toBeGreaterThan(6);
    const covered = (e: string) => has(e) || DOC.includes(`\`${e}`) || DOC.includes(e); // 'pan zoom drag' appears as a phrase
    expect([...events].filter((e) => !covered(e)), 'canvas events with no row').toEqual([]);
    for (const key of ['Escape', 'Delete', 'Backspace', '⌘Z']) expect(DOC, `shortcut ${key}`).toContain(key);
    for (const el of ['gb_grip', 'legend', 'strip', 'ledger', 'suites']) expect(has(el), `element ${el}`).toBe(true);
  });

  test('every dev-server route is in the table', () => {
    const routes = new Set([...SERVER.matchAll(/'(\/__[a-z_/]+)'/g)].map((m) => m[1]!));
    expect(routes.size).toBeGreaterThan(6);
    expect([...routes].filter((r) => !has(r)), 'routes with no row').toEqual([]);
    // The page calls what the server serves — no route invented on one side.
    const called = new Set([...JS['net.js']!.matchAll(/'(\/__[a-z_/]+)'/g)].map((m) => m[1]!));
    expect([...called].filter((r) => !routes.has(r)), 'routes the page calls that the server has no handler for').toEqual([]);
  });

  test('every window.planner API function is listed as kept', () => {
    const block = (/window\.planner = \{[\s\S]*?\n {2}\};/.exec(JS['api.js']!))?.[0] ?? '';
    // Top-level members only (four-space indent inside the module's IIFE).
    const names = new Set<string>();
    for (const line of block.split('\n')) {
      if (!/^ {4}[a-zA-Z]+:/.test(line)) continue;
      // Strip nested object/function bodies so `importCases: { open: …, read: … }` counts once.
      let depth = 0, flat = '';
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; else if (depth === 0) flat += ch; }
      for (const m of flat.matchAll(/(?:^ {4}|, )([a-zA-Z]+):/g)) names.add(m[1]!);
    }
    expect(names.size).toBeGreaterThan(20);
    const section = DOC.slice(DOC.indexOf('## 8.'), DOC.indexOf('## 9.'));
    // §8 writes the two additions with their argument lists (`script()`).
    const listed = new Set([...section.matchAll(/`([a-zA-Z]+)(?:\([^)]*\))?`/g)].map((m) => m[1]!));
    expect([...names].filter((n) => !listed.has(n)), 'planner API names not listed in §8').toEqual([]);
  });

  test('every table row has a valid disposition, and dropped rows say why', () => {
    const rows = ROWS.split('\n').filter((l) => /^\|\s*`/.test(l) || /^\| (drag|SPACE|hover|edge labels|run paint|status bar|\*\(new\)\*)/.test(l));
    expect(rows.length).toBeGreaterThan(60);
    const bad: string[] = [];
    for (const row of rows) {
      const cells = row.split('|').map((c) => c.trim()).filter((_c, i, a) => i > 0 && i < a.length - 1);
      const disp = cells[3]?.replace(/\s*\(.*\)$/, '').split(' ')[0];
      if (!disp || !DISPOSITIONS.includes(disp)) bad.push(`no disposition: ${cells[0]}`);
      if (disp === 'dropped' && !/dropped|retired|—/.test(cells[2] ?? '')) bad.push(`dropped without a reason: ${cells[0]}`);
      if (disp === 'dropped' && !/(v1|duplicated|re-adding|line kind)/.test(cells[2] ?? '')) bad.push(`dropped needs a justification: ${cells[0]}`);
    }
    expect(bad).toEqual([]);
  });

  test('the retirement holds: v1 is gone and no v2 row went back to ○', () => {
    for (const gone of ['tools/planner-src.html', 'tools/process-planner.html', 'tools/journey-planner.html']) {
      expect(fs.existsSync(path.join(ROOT, gone)), `${gone} was retired in sprint 4.1`).toBe(false);
    }
    expect(fs.existsSync(path.join(ROOT, 'tools/planner.html')), 'tools/planner.html — run npm run build:planner').toBe(true);
    // The gate itself: the last column of every parity row is shipped.
    const open = ROWS.split('\n').filter((l) => l.startsWith('|') && (l.split('|').slice(-2)[0] ?? '').includes('○'));
    expect(open, 'a v2 column cell went back to ○ after the old planner was deleted').toEqual([]);
  });
});
