#!/usr/bin/env node
/**
 * PG-2 — planner build: inlines the graph libraries (UMD) and the TRANSPILED
 * shared schema (src/graph/schema.ts — same validation as the test suite)
 * into ONE self-contained tools/process-planner.html. Run on demand:
 *
 *   npm run build:planner
 *
 * "Zero build" for USERS holds: the committed output opens anywhere as a
 * single file; this script is a maintainer step like the fixture generators.
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
      '--outDir', out, '--module', 'commonjs', '--target', 'es2019',
      '--skipLibCheck',
    ], { cwd: root, stdio: 'pipe' });
    const schemaJs = readFileSync(join(out, 'schema.js'), 'utf8');
    const gapsJs = readFileSync(join(out, 'gaps.js'), 'utf8');
    const composeJs = readFileSync(join(out, 'compose.js'), 'utf8');
    // gaps.ts imports './schema' and './compose'; compose.ts imports
    // './schema' — hand their require() the already-inlined modules (compose
    // is inlined BEFORE gaps in planner-src.html for this reason).
    const shim = "var require = function (m) { return /compose/.test(m) ? window.ProcessGraphCompose : window.ProcessGraphSchema; };";
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
    'tsc', join(root, 'src/graph/adoImports.ts'), join(root, 'src/personas/schema.ts'),
    '--outDir', out, '--rootDir', join(root, 'src'), '--module', 'commonjs', '--target', 'es2020',
    '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck',
  ], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(out, 'package.json'), '{ "type": "commonjs" }\n');
  return out;
}

const src = readFileSync(join(root, 'tools/planner-src.html'), 'utf8');
const shared = transpileShared();
buildServerBridge();
const libraryJs = graphLibrary();
const personasJs = personaIds();

let html = src;
for (const [name, file] of Object.entries(LIBS)) {
  const code = readFileSync(file, 'utf8');
  // Function replacement: library code is inserted LITERALLY ($& etc. in
  // minified sources must never be treated as replacement patterns).
  html = html.replace(`<!--INLINE:${name}-->`, () => `<script>\n${code}\n</script>`);
}
html = html.replace('<!--INLINE:schema-->', () => `<script>\n${shared.schema}\n</script>`);
html = html.replace('<!--INLINE:gaps-->', () => `<script>\n${shared.gaps}\n</script>`);
html = html.replace('<!--INLINE:compose-->', () => `<script>\n${shared.compose}\n</script>`);
html = html.replace('<!--INLINE:graphs-->', () => `<script>\n${libraryJs}\n</script>`);
html = html.replace('<!--INLINE:personas-->', () => `<script>\n${personasJs}\n</script>`);

const leftover = html.match(/<!--INLINE:[^>]+-->/);
if (leftover) throw new Error(`unresolved inline placeholder: ${leftover[0]}`);

const outFile = join(root, 'tools/process-planner.html');
writeFileSync(outFile, html);
console.log(`built ${outFile} (${(html.length / 1024).toFixed(0)} KB)`);
