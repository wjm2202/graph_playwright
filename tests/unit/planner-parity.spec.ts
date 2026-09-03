import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Feature-parity drift guard for the planner conversion
 * (docs/PLANNER-FEATURE-PARITY.md). Reads the CURRENT planner source and the
 * dev server, extracts every control id, add-menu entry, canvas event,
 * keyboard shortcut, dev-server route and window.planner API name, and fails
 * if any of them is not accounted for in the parity table — so a feature
 * cannot vanish silently while the new UI is built. Also checks that every
 * table row carries a valid disposition and that "dropped" rows say why.
 */

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'tools/planner-src.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'tools/serve-planner.mjs'), 'utf8');
const DOC = fs.readFileSync(path.join(ROOT, 'docs/PLANNER-FEATURE-PARITY.md'), 'utf8');

const DISPOSITIONS = ['kept', 'automated', 'merged', 'dropped', 'todo', 'new'];

/** Every token the doc mentions in backticks. */
const mentioned = new Set([...DOC.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
const has = (tok: string) => mentioned.has(tok);

test.describe('planner feature parity table', () => {
  test('every control id in planner-src.html is in the table', () => {
    const ids = new Set(
      [...SRC.matchAll(/<(?:button|select|input|textarea|img)\b[^>]*\bid="([a-z_0-9]+)"/g)].map((m) => m[1]!),
    );
    expect(ids.size).toBeGreaterThan(40);
    // Purely structural ids (containers) are not features; the controls inside them are.
    const structural = new Set(['export_out', 'xf_list', 'nf_id', 'ef_id', 'nf_chips']);
    const missing = [...ids].filter((id) => !has(id) && !structural.has(id) && !has(id.replace(/_img$/, '')));
    expect(missing, 'controls with no row in docs/PLANNER-FEATURE-PARITY.md').toEqual([]);
  });

  test('every add ▾ / test ▾ menu entry is in the table', () => {
    const menu = (id: string) => {
      const block = (new RegExp(`<select id="${id}"[\\s\\S]*?</select>`).exec(SRC))?.[0] ?? '';
      return [...block.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]!);
    };
    const entries = [...menu('b_add'), ...menu('f_test')];
    expect(entries.length).toBeGreaterThan(8);
    expect(entries.filter((e) => !has(e)), 'menu entries with no row').toEqual([]);
  });

  test('every edge relation type offered today is in the table', () => {
    const block = (/<select id="ef_type">[\s\S]*?<\/select>/.exec(SRC))?.[0] ?? '';
    const types = [...block.matchAll(/<option>([a-z_]+)<\/option>/g)].map((m) => m[1]!);
    expect(types.length).toBeGreaterThan(5);
    expect(types.filter((t) => !has(t)), 'relation types with no row').toEqual([]);
  });

  test('every canvas event, gesture and keyboard shortcut is in the table', () => {
    const events = new Set<string>();
    for (const m of SRC.matchAll(/cy\.on\('([a-z ]+)'/g)) for (const e of m[1]!.split(' ')) events.add(e);
    expect(events.size).toBeGreaterThan(6);
    const covered = (e: string) => has(e) || DOC.includes(`\`${e}`) || DOC.includes(e); // 'pan zoom drag' appears as a phrase
    expect([...events].filter((e) => !covered(e)), 'canvas events with no row').toEqual([]);
    for (const key of ['Escape', 'Delete', 'Backspace', '⌘Z']) expect(DOC, `shortcut ${key}`).toContain(key);
    for (const el of ['groupbox', 'gb_grip', 'gb_hit', 'legend', 'issues', 'runorder']) expect(has(el), `element ${el}`).toBe(true);
  });

  test('every dev-server route is in the table', () => {
    const routes = new Set([...SERVER.matchAll(/'(\/__[a-z_/]+)'/g)].map((m) => m[1]!));
    expect(routes.size).toBeGreaterThan(6);
    expect([...routes].filter((r) => !has(r)), 'routes with no row').toEqual([]);
  });

  test('every window.planner API function is listed as kept', () => {
    const block = (/window\.planner = \{[\s\S]*?\n\};/.exec(SRC))?.[0] ?? '';
    // Top-level members only (two-space indent); several sit on one line:
    // `deleteSelected: deleteSelected, undo: undo, undoDepth: function () {…}, …`.
    const names = new Set<string>();
    for (const line of block.split('\n')) {
      if (!/^ {2}[a-zA-Z]+:/.test(line)) continue;
      // Strip nested object/function bodies so `importCases: { open: …, read: … }` counts once.
      let depth = 0, flat = '';
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; else if (depth === 0) flat += ch; }
      for (const m of flat.matchAll(/(?:^ {2}|, )([a-zA-Z]+):/g)) names.add(m[1]!);
    }
    expect(names.size).toBeGreaterThan(20);
    const section = DOC.slice(DOC.indexOf('## 8.'), DOC.indexOf('## 9.'));
    const listed = new Set([...section.matchAll(/`([a-zA-Z]+)`/g)].map((m) => m[1]!));
    expect([...names].filter((n) => !listed.has(n)), 'planner API names not listed in §8').toEqual([]);
  });

  test('every table row has a valid disposition, and dropped rows say why', () => {
    const rows = DOC.split('\n').filter((l) => /^\|\s*`/.test(l) || /^\| (drag|SPACE|hover|edge labels|run paint|status bar|\*\(new\)\*)/.test(l));
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

  test('the prototype implements what the table says it demonstrates', () => {
    const proto = fs.readFileSync(path.join(ROOT, 'docs/PROTOTYPE-journey-script-planner.html'), 'utf8');
    // A sample of hooks the ✓ rows rely on — each must exist in the prototype.
    for (const hook of ['data-rec=', 'data-drag=', 'class="band"', 'id="ncard"', 'data-env=', 'id="b_join"', 'id="b_fixnext"', 'id="ledger"', 'id="suites"', 'data-new="paste"', 'id="b_layout"', 'id="rail_left"']) {
      expect(proto, `prototype hook ${hook}`).toContain(hook);
    }
  });
});
