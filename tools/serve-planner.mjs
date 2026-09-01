#!/usr/bin/env node
/**
 * Planner dev server — zero dependencies. `npm run planner`
 *
 * - serves tools/ over http://127.0.0.1:8765 (PLANNER_PORT overrides)
 * - rebuilds process-planner.html whenever its inputs change
 *   (planner-src.html, build-planner.mjs, src/graph/schema.ts, journeys/graphs/)
 * - live-reloads every open browser tab via SSE the moment a rebuild lands
 * - Cache-Control: no-store, so what you see is always what's on disk
 *
 * The reload snippet is injected ONLY into served HTML — the committed
 * single-file planner stays clean for file:// double-clicks and the artifact.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { listProjects, scaffoldProject } from './scaffold-project.mjs';

/**
 * The TypeScript import store, transpiled by build-planner into
 * tools/.planner-build/ (see buildServerBridge). Required lazily and with
 * the cache dropped, so a rebuild is picked up without restarting.
 */
const requireCjs = createRequire(import.meta.url);
function importStore() {
  const file = join(toolsDir, '.planner-build', 'graph', 'adoImports.js');
  if (!existsSync(file)) throw new Error('import store not built — run npm run build:planner (the dev server does this on start)');
  for (const key of Object.keys(requireCjs.cache)) if (key.startsWith(join(toolsDir, '.planner-build'))) delete requireCjs.cache[key];
  return requireCjs(file);
}
/** The transpiled validator — the SAME code the planner and the suite run. */
function importSchema() {
  const file = join(toolsDir, '.planner-build', 'graph', 'schema.js');
  if (!existsSync(file)) throw new Error('validator bridge not built — run npm run build:planner (the dev server does this on start)');
  return requireCjs(file);
}
/** Persona ids from the data root's personas.json (draft-graph role binding hints). */
function knownPersonas() {
  try {
    const doc = JSON.parse(readFileSync(join(dataRoot, 'personas.json'), 'utf8'));
    return Object.keys(doc.personas ?? {});
  } catch { return []; }
}
function readJson(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { req.destroy(); rejectBody(new Error(`body over ${limit} bytes`)); } });
    req.on('end', () => { try { resolveBody(JSON.parse(raw || '{}')); } catch (e) { rejectBody(new Error(`bad json: ${e.message}`)); } });
    req.on('error', rejectBody);
  });
}
function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(root, 'tools');
/** Where personas.json/.env live — override for tests (PLANNER_ROOT). */
const dataRoot = process.env.PLANNER_ROOT ? resolve(process.env.PLANNER_ROOT) : root;
const port = Number(process.env.PLANNER_PORT || 8765);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export const RELOAD_SNIPPET =
  "<script>(function(){try{new EventSource('/__reload').addEventListener('message',function(){location.reload()});}catch(e){}})();</script>";

/** Inject the live-reload listener into served HTML (pure; unit-tested). */
export function injectReload(html) {
  const i = html.lastIndexOf('</body>');
  if (i === -1) return html + RELOAD_SNIPPET;
  return html.slice(0, i) + RELOAD_SNIPPET + html.slice(i);
}

export function contentTypeFor(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const clients = new Set();
  let building = false;
  let queued = false;

  const rebuild = (reason) => {
    // Tests run the server on a sandbox root while OTHER tests load the
    // committed planner file — a rebuild mid-read would tear it. Opt out.
    if (process.env.PLANNER_NO_REBUILD) { console.log(`· rebuild skipped (${reason}) — PLANNER_NO_REBUILD`); return; }
    if (building) { queued = true; return; }
    building = true;
    const t0 = Date.now();
    execFile('node', [join(toolsDir, 'build-planner.mjs')], (err, stdout, stderr) => {
      building = false;
      if (err) {
        console.error(`✗ rebuild failed (${reason}):\n${stderr || stdout || err.message}`);
      } else {
        console.log(`✔ rebuilt in ${Date.now() - t0}ms (${reason}) — reloading ${clients.size} tab(s)`);
        for (const res of clients) res.write('data: reload\n\n');
      }
      if (queued) { queued = false; rebuild('queued change'); }
    });
  };

  let timer;
  const onChange = (what) => {
    clearTimeout(timer);
    timer = setTimeout(() => rebuild(what), 150);
  };

  const watchTargets = [
    join(toolsDir, 'planner-src.html'),
    join(toolsDir, 'build-planner.mjs'),
    join(root, 'src', 'graph', 'schema.ts'),
    join(root, 'src', 'graph', 'gaps.ts'),
    join(root, 'personas.json'),
    join(root, 'journeys', 'graphs'),
    join(root, 'projects'),
  ];
  for (const target of watchTargets) {
    if (!existsSync(target)) continue;
    try {
      watch(target, { persistent: true }, () => onChange(target.slice(root.length + 1)));
    } catch (e) {
      console.warn(`(watch unavailable for ${target}: ${e.message})`);
    }
  }

  /** name → isSet booleans for exactly the env names personas.json wires. */
  function envStatus() {
    const status = {};
    try {
      const doc = JSON.parse(readFileSync(join(dataRoot, 'personas.json'), 'utf8'));
      const dotenv = {};
      const envFile = join(dataRoot, '.env');
      if (existsSync(envFile)) {
        for (const line of readFileSync(envFile, 'utf8').split('\n')) {
          const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (m) dotenv[m[1]] = m[2].trim();
        }
      }
      const isSet = (name) => !!(process.env[name]?.trim() || dotenv[name]);
      const names = new Set([doc.org?.instanceUrlEnv]);
      for (const s of Object.values(doc.sites ?? {})) names.add(s.urlEnv);
      for (const p of Object.values(doc.personas ?? {})) {
        for (const k of ['usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv']) if (p[k]) names.add(p[k]);
      }
      for (const n of names) if (n) status[n] = isSet(n);
    } catch { /* empty status — planner shows names without dots */ }
    return status;
  }

  // Same names-only rules as src/personas/schema.ts (kept dependency-free).
  const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
  function badEnvName(v) {
    if (!ENV_NAME_RE.test(v)) return 'must be an ENV VAR NAME (A-Z, digits, underscores)';
    if (v.length > 64) return 'too long for an env name';
    if (v.length >= 12 && !v.includes('_')) return 'looks like a pasted secret, not a name — names are worded, like SFDC_UAT_USERNAME';
    return null;
  }

  /**
   * POST /__personas — remap ONE persona's credential env NAMES onto the
   * team's existing .env vocabulary. Writes personas.json (names only —
   * .env itself is never touched). Fields: usernameEnv/passwordEnv/
   * tokenEnv/totpEnv ('' clears optional ones) + urlEnv (routes to the
   * persona's site, else the org).
   */
  function updatePersonaWiring(body) {
    const file = join(dataRoot, 'personas.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const p = doc.personas?.[body.personaId];
    if (!p) return { code: 404, error: `unknown persona '${body.personaId}'` };
    if (p.kind === 'guest') return { code: 400, error: 'guest personas have no credentials' };

    for (const key of ['usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv']) {
      if (!(key in body)) continue;
      const v = String(body[key] ?? '').trim();
      if (!v) {
        if (key === 'usernameEnv') return { code: 400, error: 'usernameEnv is required for authenticated personas' };
        delete p[key];
        continue;
      }
      const bad = badEnvName(v);
      if (bad) return { code: 400, error: `${key}: ${bad}` };
      p[key] = v;
    }
    if ('urlEnv' in body) {
      const v = String(body.urlEnv ?? '').trim();
      const bad = v ? badEnvName(v) : 'url env name cannot be empty';
      if (bad) return { code: 400, error: `urlEnv: ${bad}` };
      if (p.site && doc.sites?.[p.site]) doc.sites[p.site].urlEnv = v;
      else doc.org.instanceUrlEnv = v;
    }

    writeFileSync(file + '.tmp', JSON.stringify(doc, null, 2) + '\n');
    renameSync(file + '.tmp', file);
    const url = p.site && doc.sites?.[p.site] ? doc.sites[p.site].urlEnv : doc.org.instanceUrlEnv;
    const warning = !p.passwordEnv && !p.tokenEnv
      ? 'no password or token mapping left — this persona cannot authenticate until one is wired'
      : undefined;
    return {
      code: 200,
      ...(warning ? { warning } : {}),
      wiring: {
        ...(p.usernameEnv ? { username: p.usernameEnv } : {}),
        ...(p.passwordEnv ? { password: p.passwordEnv } : {}),
        ...(p.tokenEnv ? { token: p.tokenEnv } : {}),
        ...(p.totpEnv ? { totp: p.totpEnv } : {}),
        url,
        ...(p.kind ? { kind: p.kind } : {}),
      },
    };
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/__reload') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (url.pathname === '/__projects' && req.method === 'GET') {
      // The filesystem IS the registry — projects/*/project.json, no names in code.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ projects: listProjects(dataRoot) }));
      return;
    }
    if (url.pathname === '/__projects' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
      req.on('end', () => {
        let out;
        try {
          const body = JSON.parse(raw);
          const { manifest } = scaffoldProject(dataRoot, {
            project: String(body.project ?? '').trim(),
            team: String(body.team ?? '').trim(),
          });
          out = { code: 200, manifest };
          rebuild(`new project '${manifest.project}'`); // regroup the built-in library
        } catch (e) {
          out = { code: 400, error: e.message };
        }
        res.writeHead(out.code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out.code === 200
          ? { ok: true, project: out.manifest, projects: listProjects(dataRoot) }
          : { ok: false, error: out.error }));
      });
      return;
    }
    // ---- test-case imports (STUDY: "import test cases" — owner 2026-09-02) ----
    // GET  /__imports?project=p            → { imports: manifest[] }
    // POST /__imports  {project, filename, contentBase64}
    //                                      → { ok, import: manifest, skippedSheets }
    // POST /__imports/apply {project, importId, indexes[]}
    //                                      → { ok, results[], import: manifest }
    if (url.pathname === '/__imports' && req.method === 'GET') {
      try {
        const project = String(url.searchParams.get('project') ?? '');
        sendJson(res, 200, { ok: true, imports: importStore().listImports(dataRoot, project) });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (url.pathname === '/__imports' && req.method === 'POST') {
      readJson(req, 25_000_000).then((body) => {
        try {
          const data = Buffer.from(String(body.contentBase64 ?? ''), 'base64');
          if (!data.length) throw new Error('empty file');
          const { manifest, skippedSheets } = importStore().storeImport(dataRoot, String(body.project ?? ''), String(body.filename ?? 'import.csv'), data);
          sendJson(res, 200, { ok: true, import: manifest, skippedSheets });
        } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }
    if (url.pathname === '/__imports/apply' && req.method === 'POST') {
      readJson(req, 100_000).then((body) => {
        try {
          const indexes = Array.isArray(body.indexes) ? body.indexes.map((n) => Number(n)).filter((n) => Number.isInteger(n) && n >= 0) : [];
          if (!indexes.length) throw new Error('pick at least one test case');
          const { manifest, results } = importStore().applyImport(
            dataRoot, String(body.project ?? ''), String(body.importId ?? ''), indexes, { knownPersonas: knownPersonas() },
          );
          rebuild(`imported ${results.length} test case(s) into '${body.project}'`); // the library regroups
          sendJson(res, 200, { ok: true, results, import: manifest });
        } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }
    // ---- save a graph INTO a project (owner 2026-09-02: "set save up so it
    // does this for us"). POST /__graphs {project, graph, overwrite?}
    // → 200 {ok, ref, file} · 409 {exists:true} when the file is there and
    // overwrite is not set · 400 on an invalid graph / unknown project.
    if (url.pathname === '/__graphs' && req.method === 'POST') {
      readJson(req, 5_000_000).then((body) => {
        try {
          const project = String(body.project ?? '').trim();
          if (!/^[a-z][a-z0-9_-]*$/.test(project)) throw new Error(`project '${project}' must be lower-case letters, digits, _ or -`);
          const projectDir = join(dataRoot, 'projects', project);
          if (!existsSync(join(projectDir, 'project.json'))) throw new Error(`project '${project}' does not exist — create it first`);
          const graph = body.graph;
          if (!graph || typeof graph !== 'object') throw new Error('graph object required');
          const { validateGraph } = importSchema();
          const v = validateGraph(graph);
          if (!v.ok) throw new Error(`graph invalid: ${v.errors.join(' | ')}`);
          const id = String(graph.id);
          const dir = join(projectDir, 'graphs');
          const file = join(dir, `${id}.graph.json`);
          if (existsSync(file) && !body.overwrite) {
            sendJson(res, 409, { ok: false, exists: true, error: `'${project}/${id}' already exists — overwrite?` });
            return;
          }
          mkdirSync(dir, { recursive: true });
          const tmp = `${file}.${process.pid}.tmp`;
          writeFileSync(tmp, JSON.stringify(graph, null, 2) + '\n');
          renameSync(tmp, file);
          rebuild(`saved '${project}/${id}'`); // the library picks it up
          sendJson(res, 200, { ok: true, ref: `${project}/${id}`, file: `projects/${project}/graphs/${id}.graph.json`, overwritten: !!body.overwrite });
        } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }
    if (url.pathname === '/__envstatus') {
      // SET/UNSET booleans ONLY for env names personas.json declares.
      // Values never leave the server — this is a presence check, not a leak.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(envStatus()));
      return;
    }
    if (url.pathname === '/__personas' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
      req.on('end', () => {
        let out;
        try {
          out = updatePersonaWiring(JSON.parse(raw));
        } catch (e) {
          out = { code: 400, error: `bad request: ${e.message}` };
        }
        res.writeHead(out.code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(out.code === 200
          ? { ok: true, wiring: out.wiring, envstatus: envStatus(), ...(out.warning ? { warning: out.warning } : {}) }
          : { ok: false, error: out.error }));
      });
      return;
    }
    const rel = url.pathname === '/' ? '/process-planner.html' : url.pathname;
    const file = normalize(join(toolsDir, rel));
    if (!file.startsWith(toolsDir) || !existsSync(file)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = contentTypeFor(file);
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    if (type.startsWith('text/html')) res.end(injectReload(readFileSync(file, 'utf8')));
    else res.end(readFileSync(file));
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(
        `✗ port ${port} is busy — stop whatever serves it (e.g. the python http.server, Ctrl+C) or run: PLANNER_PORT=${port + 1} npm run planner`,
      );
      process.exit(1);
    }
    throw e;
  });

  rebuild('startup');
  server.listen(port, '127.0.0.1', () => {
    const actual = server.address().port; // PLANNER_PORT=0 → OS-assigned (tests)
    console.log(`process planner → http://127.0.0.1:${actual}/process-planner.html`);
    console.log('watching planner-src.html, build-planner.mjs, src/graph/schema.ts, journeys/graphs/ — edits rebuild + live-reload. Ctrl+C to stop.');
  });
}
