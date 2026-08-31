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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
      'tsc', join(root, 'src/graph/schema.ts'), join(root, 'src/graph/gaps.ts'),
      '--outDir', out, '--module', 'commonjs', '--target', 'es2019',
      '--skipLibCheck',
    ], { cwd: root, stdio: 'pipe' });
    const schemaJs = readFileSync(join(out, 'schema.js'), 'utf8');
    const gapsJs = readFileSync(join(out, 'gaps.js'), 'utf8');
    return {
      schema: [
        '(function () {', 'var exports = {};', schemaJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphSchema = exports;', '})();',
      ].join('\n'),
      // gaps.ts imports './schema' — hand its require() the already-inlined module.
      gaps: [
        '(function () {', 'var exports = {};',
        'var require = function () { return window.ProcessGraphSchema; };',
        gapsJs.replace(/^"use strict";\s*/, ''),
        'window.ProcessGraphGaps = exports;', '})();',
      ].join('\n'),
    };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** The persona roster + credential env-var NAMES (names only, NEVER values) —
 *  the check panel knows who exists and the session card shows where each
 *  credential comes from in .env. */
function personaIds() {
  const file = join(root, 'personas.json');
  let ids = [];
  const wiring = {};
  let orgUrlEnv = '';
  const siteUrlEnvs = {};
  if (existsSync(file)) {
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      ids = Object.keys(doc.personas ?? {}).sort();
      orgUrlEnv = doc.org?.instanceUrlEnv ?? '';
      for (const [k, s] of Object.entries(doc.sites ?? {})) siteUrlEnvs[k] = s.urlEnv;
      for (const [id, p] of Object.entries(doc.personas ?? {})) {
        wiring[id] = {
          ...(p.usernameEnv ? { username: p.usernameEnv } : {}),
          ...(p.passwordEnv ? { password: p.passwordEnv } : {}),
          ...(p.tokenEnv ? { token: p.tokenEnv } : {}),
          ...(p.totpEnv ? { totp: p.totpEnv } : {}),
          ...(p.site && siteUrlEnvs[p.site] ? { url: siteUrlEnvs[p.site] } : { url: orgUrlEnv }),
          ...(p.kind ? { kind: p.kind } : {}),
          // How Cast acquires this persona's session — the check panel
          // compares it against what a login_as edge declares.
          ...(p.auth ? { auth: p.auth } : {}),
        };
      }
    } catch { /* roster stays empty — planner degrades gracefully */ }
  }
  return `window.PERSONA_IDS = ${JSON.stringify(ids)};\nwindow.PERSONA_ENV = ${JSON.stringify(wiring)};`;
}

/** Repo graphs (journeys/graphs/*.graph.json) embed as the built-in library. */
function graphLibrary() {
  const dir = join(root, 'journeys/graphs');
  const lib = {};
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.graph.json')).sort()) {
      const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (doc && doc.id) lib[doc.id] = doc;
    }
  }
  return `window.GRAPH_LIBRARY = ${JSON.stringify(lib)};`;
}

const src = readFileSync(join(root, 'tools/planner-src.html'), 'utf8');
const shared = transpileShared();
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
html = html.replace('<!--INLINE:graphs-->', () => `<script>\n${libraryJs}\n</script>`);
html = html.replace('<!--INLINE:personas-->', () => `<script>\n${personasJs}\n</script>`);

const leftover = html.match(/<!--INLINE:[^>]+-->/);
if (leftover) throw new Error(`unresolved inline placeholder: ${leftover[0]}`);

const outFile = join(root, 'tools/process-planner.html');
writeFileSync(outFile, html);
console.log(`built ${outFile} (${(html.length / 1024).toFixed(0)} KB)`);
