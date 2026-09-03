/**
 * S3.1 (re-pointed in S4.1) — the planner build emits tools/planner.html, and
 * it really carries what tools/planner-v2/ declares.
 *
 * The planner is assembled from files rather than authored as one HTML blob,
 * so the two ways it can rot silently are (a) a module that exists but is not
 * listed in modules.json, and (b) a committed tools/planner.html that is
 * older than its sources. Both are checked here by comparing the output
 * against the sources byte for byte, which also means a green run of this
 * spec is a promise that the harness specs are driving today's code.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = path.join(ROOT, 'tools/planner-v2');
const OUT = path.join(ROOT, 'tools/planner.html');

const modules = JSON.parse(fs.readFileSync(path.join(SRC, 'modules.json'), 'utf8')) as string[];

test('the build emits ONE planner, and the retired one stays deleted', () => {
  expect(fs.existsSync(OUT), 'tools/planner.html — run npm run build:planner').toBe(true);
  expect(fs.readFileSync(OUT, 'utf8')).toContain("version: 'planner/2'");
  // S4.1: v1 authoring is gone — source, output and the build branch alike.
  for (const gone of ['tools/planner-src.html', 'tools/process-planner.html', 'tools/journey-planner.html']) {
    expect(fs.existsSync(path.join(ROOT, gone)), `${gone} was retired in sprint 4.1`).toBe(false);
  }
  expect(fs.readFileSync(path.join(ROOT, 'tools/build-planner.mjs'), 'utf8')).not.toContain('buildV1');
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
  const built = fs.readFileSync(OUT, 'utf8');
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
  const built = fs.readFileSync(OUT, 'utf8');
  expect(built).toContain(fs.readFileSync(path.join(SRC, 'style.css'), 'utf8'));
  expect(built).toContain('<div class="strip" id="strip">');
  expect(built).toContain('<div class="stage" id="cy"');   // sprint 3.2 mounts here
  expect(built).toContain('<div class="sheet" id="sheet">'); // sprint 3.3 fills this
  expect(/<!--INLINE:[^>]+-->/.exec(built), 'an unresolved inline placeholder').toBeNull();
});

test('the shared modules ride along — including the script codec', () => {
  const built = fs.readFileSync(OUT, 'utf8');
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

test('the dev server serves and watches the planner source, and npm run planner is the door', () => {
  const server = fs.readFileSync(path.join(ROOT, 'tools/serve-planner.mjs'), 'utf8');
  expect(server).toContain("join(toolsDir, 'planner-v2')");
  expect(server).toContain("PLANNER_FILE = 'planner.html'");
  // No planner-src to watch, and no flag to choose between planners.
  expect(server).not.toContain('planner-src.html');
  expect(server).not.toContain('PLANNER_V2');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  expect(pkg.scripts.planner).toBe('node tools/serve-planner.mjs');
  expect(pkg.scripts['planner:v2'], 'the v2 flag went with the retirement').toBeUndefined();
});
