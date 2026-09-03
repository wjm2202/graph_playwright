#!/usr/bin/env node
/**
 * PG-2 — planner build: inlines the graph libraries (UMD) and the TRANSPILED
 * shared modules (src/graph/schema.ts + compose/gaps/infer/upgrade/script —
 * the SAME validation, referees, inference and v1 load door as the test
 * suite) into ONE self-contained tools/planner.html. Run on demand:
 *
 *   npm run build:planner
 *
 * "Zero build" for USERS holds: the committed output opens anywhere as a
 * single file; this script is a maintainer step like the fixture generators.
 *
 * Sprint 4.1 (2026-09-03) retired the old planner: `tools/planner-src.html`
 * and its `tools/process-planner.html` output are gone, and the Journey
 * Script Planner in tools/planner-v2/ IS the planner.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountList, personaWiring } from './persona-wiring.mjs';
import { listProjects } from './scaffold-project.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nm = (p) => join(root, 'node_modules', p);

const LIBS = {
  cytoscape: nm('cytoscape/dist/cytoscape.min.js'),
  dagre: nm('dagre/dist/dagre.min.js'),
  'cytoscape-dagre': nm('cytoscape-dagre/dist/cytoscape-dagre.min.js'),
  // edgehandles' browser UMD reads root._.memoize / root._.throttle — lodash
  // MUST be inlined before it or drag-to-connect dies silently (caught live
  // in Chrome 2026-08-31; boot test now asserts eh registration).
  lodash: nm('lodash/lodash.min.js'),
  'cytoscape-edgehandles': nm('cytoscape-edgehandles/cytoscape-edgehandles.js'),
};

function transpileShared() {
  const out = mkdtempSync(join(tmpdir(), 'planner-schema-'));
  try {
    execFileSync('npx', [
      'tsc', join(root, 'src/graph/schema.ts'), join(root, 'src/graph/gaps.ts'), join(root, 'src/graph/compose.ts'),
      join(root, 'src/graph/upgrade.ts'), join(root, 'src/graph/infer.ts'),
      // v2 only: the script codec, and fromAdo because script.ts borrows its
      // slug(). fromAdo's `fs`/`path` imports never run in the browser (only
      // writeAdoGraph uses them), and the shim hands them an empty object.
      join(root, 'src/graph/script.ts'), join(root, 'src/graph/fromAdo.ts'),
      '--outDir', out, '--module', 'commonjs', '--target', 'es2019',
      '--skipLibCheck',
    ], { cwd: root, stdio: 'pipe' });
    const schemaJs = readFileSync(join(out, 'schema.js'), 'utf8');
    const gapsJs = readFileSync(join(out, 'gaps.js'), 'utf8');
    const composeJs = readFileSync(join(out, 'compose.js'), 'utf8');
    const upgradeJs = readFileSync(join(out, 'upgrade.js'), 'utf8');
    const inferJs = readFileSync(join(out, 'infer.js'), 'utf8');
    const scriptJs = readFileSync(join(out, 'script.js'), 'utf8');
    const fromAdoJs = readFileSync(join(out, 'fromAdo.js'), 'utf8');
    // gaps.ts and infer.ts import './schema' and './compose'; compose.ts
    // imports './schema'; script.ts imports all three plus './fromAdo' —
    // hand their require() the already-inlined modules (the placeholders in
    // both sources are ordered so the dependency is always emitted first).
    // Anything else — node's `fs`, `path` — gets an empty object rather than
    // the wrong module: an unresolved import must fail loudly at USE, not
    // silently succeed with a schema function bound to it.
    const shim = 'var require = function (m) { '
      + 'return /fromAdo/.test(m) ? window.ProcessGraphFromAdo '
      + ': /compose/.test(m) ? window.ProcessGraphCompose '
      + ': /schema/.test(m) ? window.ProcessGraphSchema : {}; };';
    return {
      schema: [
        '(function () {', 'var exports = {};', schemaJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphSchema = exports;', '})();',
      ].join('\n'),
      gaps: [
        '(function () {', 'var exports = {};', shim,
        gapsJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphGaps = exports;', '})();',
      ].join('\n'),
      compose: [
        '(function () {', 'var exports = {};', shim,
        composeJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphCompose = exports;', '})();',
      ].join('\n'),
      // The inference half (relations, catalog names, first-touch ports):
      // requires './schema' + './compose', so it rides the compose slot,
      // emitted immediately after it — one placeholder, guaranteed order.
      infer: [
        '(function () {', 'var exports = {};', shim,
        inferJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphInfer = exports;', '})();',
      ].join('\n'),
      // The load door: upgrade.ts requires './schema' only, so the same shim serves.
      upgrade: [
        '(function () {', 'var exports = {};', shim,
        upgradeJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphUpgrade = exports;', '})();',
      ].join('\n'),
      // planner v2's script codec: fromAdo first (script.ts borrows slug),
      // then the codec itself. One placeholder, guaranteed order.
      script: [
        '(function () {', 'var exports = {};', shim,
        fromAdoJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphFromAdo = exports;', '})();',
        '(function () {', 'var exports = {};', shim,
        scriptJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphScript = exports;', '})();',
      ].join('\n'),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** personas.json → page-side roster: ids, wiring (names only), accounts. */
function personaIds() {
  const file = join(root, 'personas.json');
  let ids = [];
  let wiring = {};
  let accounts = [];
  if (existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      const lib = createRequire(import.meta.url)(join(root, 'tools/.planner-build/personas/schema.js'));
      ids = Object.keys(doc.personas ?? {}).sort();
      wiring = personaWiring(doc, lib);
      accounts = accountList(doc, lib);
    } catch { /* roster stays empty — planner degrades gracefully */ }
  }
  return `window.PERSONA_IDS = ${JSON.stringify(ids)};\nwindow.PERSONA_ENV = ${JSON.stringify(wiring)};\nwindow.PERSONA_ACCOUNTS = ${JSON.stringify(accounts)};`;
}

/** Repo graphs embed as the built-in library, keyed by REF: legacy
 *  journeys/graphs/ entries as bare ids, project graphs as `project/id`
 *  (DESIGN-PROJECTS.md §3.2). PROJECT_LIST carries the manifests so the
 *  planner's project selector needs no server to render. */
function graphLibrary() {
  const lib = {};
  const legacyDir = join(root, 'journeys/graphs');
  if (existsSync(legacyDir)) {
    for (const f of readdirSync(legacyDir).filter((x) => x.endsWith('.graph.json')).sort()) {
      const doc = JSON.parse(readFileSync(join(legacyDir, f), 'utf8'));
      if (doc && doc.id) lib[doc.id] = doc;
    }
  }
  const projects = listProjects(root);
  for (const p of projects) {
    const dir = join(root, 'projects', p.project, 'graphs');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.graph.json')).sort()) {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (doc && doc.id) lib[`${p.project}/${doc.id}`] = doc;
    }
  }
  return `window.GRAPH_LIBRARY = ${JSON.stringify(lib)};\nwindow.PROJECT_LIST = ${JSON.stringify(projects)};`;
}

/**
 * Server bridge: the dev server (plain .mjs) needs the TypeScript import
 * store (src/graph/adoImports.ts → fromAdo, fromAdoXlsx, schema). Transpile
 * it to CommonJS under tools/.planner-build/ (gitignored) on every build so
 * serve-planner can createRequire() it fresh after each rebuild.
 */
function buildServerBridge() {
  const out = join(root, 'tools/.planner-build');
  // tsc overwrites in place — no rm first (some sandboxes forbid unlink on
  // mounted folders, and a stale sibling file is harmless).
  execFileSync('npx', [
    'tsc', join(root, 'src/graph/adoImports.ts'), join(root, 'src/graph/evidence.ts'),
    join(root, 'src/personas/schema.ts'), join(root, 'src/personas/wiring.ts'),
    '--outDir', out, '--rootDir', join(root, 'src'), '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck',
  ], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(out, 'package.json'), '{ "type": "commonjs" }\n');
  return out;
}

/** The five UMD libraries, inlined literally (never as replacement patterns). */
function inlineLibs(html) {
  for (const [name, file] of Object.entries(LIBS)) {
    const code = readFileSync(file, 'utf8');
    // Function replacement: library code is inserted LITERALLY ($& etc. in
    // minified sources must never be treated as replacement patterns).
    html = html.replace(`<!--INLINE:${name}-->`, () => `<script>\n${code}\n</script>`);
  }
  return html;
}

function assertResolved(html, outFile) {
  const leftover = html.match(/<!--INLINE:[^>]+-->/);
  if (leftover) throw new Error(`${outFile}: unresolved inline placeholder ${leftover[0]}`);
}

/**
 * The planner — tools/planner-v2/{index.html,style.css,js/*} →
 * tools/planner.html. The JS modules are concatenated in the ORDER declared
 * by tools/planner-v2/modules.json: they are IIFEs over one `window.P2`
 * namespace, so the order is the dependency graph and it lives in data, not
 * in a bundler config.
 */
function buildV2(shared, libraryJs, personasJs) {
  const dir = join(root, 'tools/planner-v2');
  let html = inlineLibs(readFileSync(join(dir, 'index.html'), 'utf8'));
  html = html.replace('<!--INLINE:schema-->', () => `<script>\n${shared.schema}\n</script>`);
  html = html.replace('<!--INLINE:upgrade-->', () => `<script>\n${shared.upgrade}\n</script>`);
  html = html.replace('<!--INLINE:compose-->', () => `<script>\n${shared.compose}\n</script>\n<script>\n${shared.infer}\n</script>`);
  html = html.replace('<!--INLINE:gaps-->', () => `<script>\n${shared.gaps}\n</script>`);
  html = html.replace('<!--INLINE:script-->', () => `<script>\n${shared.script}\n</script>`);
  html = html.replace('<!--INLINE:graphs-->', () => `<script>\n${libraryJs}\n</script>`);
  html = html.replace('<!--INLINE:personas-->', () => `<script>\n${personasJs}\n</script>`);

  const css = readFileSync(join(dir, 'style.css'), 'utf8');
  const order = JSON.parse(readFileSync(join(dir, 'modules.json'), 'utf8'));
  const js = order.map((name) => {
    const file = join(dir, 'js', name);
    if (!existsSync(file)) throw new Error(`modules.json names ${name}, which does not exist in tools/planner-v2/js/`);
    // A marker per module: the build test asserts every declared module made
    // it into the output, so a rename cannot silently drop one.
    return `/* ==== planner-v2 module: ${name} ==== */\n${readFileSync(file, 'utf8')}`;
  }).join('\n');

  html = html.replace('<!--INLINE:v2:css-->', () => css);
  html = html.replace('<!--INLINE:v2:js-->', () => js);

  const outFile = join(root, 'tools/planner.html');
  assertResolved(html, outFile);
  writeFileSync(outFile, html);
  return { file: outFile, size: html.length };
}

const shared = transpileShared();
buildServerBridge();
const libraryJs = graphLibrary();
const personasJs = personaIds();

const built = buildV2(shared, libraryJs, personasJs);
console.log(`built ${built.file} (${(built.size / 1024).toFixed(0)} KB)`);
