/**
 * S3.1 — the planner build emits BOTH planners, and the v2 one really carries
 * what tools/planner-v2/ declares.
 *
 * The v2 planner is assembled from files rather than authored as one HTML
 * blob, so the two ways it can rot silently are (a) a module that exists but
 * is not listed in modules.json, and (b) a committed tools/journey-planner.html
 * that is older than its sources. Both are checked here by comparing the
 * output against the sources byte for byte, which also means a green run of
 * this spec is a promise that the harness spec is driving today's code.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'tools/planner-v2');
const V2 = path.join(ROOT, 'tools/journey-planner.html');
const V1 = path.join(ROOT, 'tools/process-planner.html');

const modules = JSON.parse(fs.readFileSync(path.join(SRC, 'modules.json'), 'utf8')) as string[];

test('the build emits both planners', () => {
  expect(fs.existsSync(V1), 'tools/process-planner.html (v1) — run npm run build:planner').toBe(true);
  expect(fs.existsSync(V2), 'tools/journey-planner.html (v2) — run npm run build:planner').toBe(true);
  expect(fs.readFileSync(V1, 'utf8')).toContain("version: 'planner/1'");
  expect(fs.readFileSync(V2, 'utf8')).toContain("version: 'planner/2'");
});

test('modules.json is the whole module list, in dependency order', () => {
  const onDisk = fs.readdirSync(path.join(SRC, 'js')).filter((f) => f.endsWith('.js')).sort();
  expect([...modules].sort(), 'every js/*.js must be declared in modules.json').toEqual(onDisk);
  // The order is the dependency graph: state first (the namespace), main last
  // (it boots), and the two 3.2/3.3 stubs before the API that delegates to them.
  expect(modules[0]).toBe('state.js');
  expect(modules[modules.length - 1]).toBe('main.js');
  expect(modules.indexOf('canvas.js')).toBeLessThan(modules.indexOf('api.js'));
  expect(modules.indexOf('sheets.js')).toBeLessThan(modules.indexOf('api.js'));
  expect(modules.indexOf('view.js')).toBeLessThan(modules.indexOf('ops.js'));
});

test('every declared module is inlined, in order, byte for byte', () => {
  const built = fs.readFileSync(V2, 'utf8');
  let cursor = -1;
  for (const name of modules) {
    const marker = `/* ==== planner-v2 module: ${name} ==== */`;
    const at = built.indexOf(marker);
    expect(at, `${name} is missing from the build — run npm run build:planner`).toBeGreaterThan(cursor);
    cursor = at;
    const source = fs.readFileSync(path.join(SRC, 'js', name), 'utf8');
    expect(built.includes(source), `${name} in the build is not the file on disk — rebuild`).toBe(true);
  }
});

test('the stylesheet and the markup are inlined, and no placeholder is left', () => {
  const built = fs.readFileSync(V2, 'utf8');
  expect(built).toContain(fs.readFileSync(path.join(SRC, 'style.css'), 'utf8'));
  expect(built).toContain('<div class="strip" id="strip">');
  expect(built).toContain('<div class="stage" id="cy"');   // sprint 3.2 mounts here
  expect(built).toContain('<div class="sheet" id="sheet">'); // sprint 3.3 fills this
  expect(/<!--INLINE:[^>]+-->/.exec(built), 'an unresolved inline placeholder').toBeNull();
});

test('the shared modules ride along — including the script codec v2 adds', () => {
  const built = fs.readFileSync(V2, 'utf8');
  for (const global of [
    'window.ProcessGraphSchema = exports;',
    'window.ProcessGraphUpgrade = exports;',
    'window.ProcessGraphCompose = exports;',
    'window.ProcessGraphInfer = exports;',
    'window.ProcessGraphGaps = exports;',
    'window.ProcessGraphFromAdo = exports;',
    'window.ProcessGraphScript = exports;',
  ]) expect(built, `${global} missing`).toContain(global);
  // …and the graph libraries the canvas needs in 3.2 are already there
  // (edgehandles registers itself, hence the bare name — the boot test in
  // the harness proves it actually registered).
  expect(built).toContain('edgehandles');
  expect(built).toContain('dagre');
  expect(built).toContain('window.GRAPH_LIBRARY =');
  expect(built).toContain('window.PERSONA_ENV =');
});

test('the dev server serves and watches the v2 source', () => {
  const server = fs.readFileSync(path.join(ROOT, 'tools/serve-planner.mjs'), 'utf8');
  expect(server).toContain("join(toolsDir, 'planner-v2')");
  expect(server).toContain('journey-planner.html');
  expect(server).toContain('PLANNER_V2');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts['planner:v2']).toContain('PLANNER_V2=1');
});
