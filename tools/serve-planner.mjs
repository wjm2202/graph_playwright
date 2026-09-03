#!/usr/bin/env node
/**
 * Planner dev server — zero dependencies. `npm run planner`
 *
 * - serves tools/ over http://127.0.0.1:8765 (PLANNER_PORT overrides). `/`
 *   is planner v1 (process-planner.html) until sprint 4 retires it;
 *   PLANNER_V2=1 (npm run planner:v2) makes it the journey script planner.
 *   Both files are always built and always reachable by name.
 * - rebuilds BOTH planners whenever the PLANNER SOURCE changes
 *   (planner-src.html, planner-v2/**, build-planner.mjs, src/graph/*.ts) and live-reloads
 *   every open tab via SSE. Saved DATA — graphs, projects, personas — is read
 *   back over /__library, /__projects and /__personas instead: a save is a
 *   fetch, never a 1.1 MB re-inline plus a reload of the app you are editing
 *   (review §5.3 d, 2026-09-03).
 * - Cache-Control: no-store, so what you see is always what's on disk
 *
 * The reload snippet is injected ONLY into served HTML — the committed
 * single-file planner stays clean for file:// double-clicks and the artifact.
 */
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, watch, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { accountList, personaWiring } from './persona-wiring.mjs';
import { listProjects, scaffoldProject } from './scaffold-project.mjs';

const requireCjs = createRequire(import.meta.url);
/** Transpiled TypeScript this server runs: bridge name → [built js, source]. */
const BRIDGE = {
  imports: ['graph/adoImports.js', 'src/graph/adoImports.ts'],
  schema: ['graph/schema.js', 'src/graph/schema.ts'],
  personas: ['personas/schema.js', 'src/personas/schema.ts'],
  wiring: ['personas/wiring.js', 'src/personas/wiring.ts'],
};
/**
 * One of those modules, from tools/.planner-build/ (build-planner's
 * buildServerBridge writes it). Missing → transpiled here on the spot, so a
 * fresh clone and CI (which never runs build:planner) still serve every
 * route. The require cache is dropped first: a rebuild lands without a
 * restart.
 */
function bridge(name) {
  const [rel, src] = BRIDGE[name];
  const file = join(bridgeDir, rel);
  if (!existsSync(file)) transpileBridge(name, src, file);
  for (const key of Object.keys(requireCjs.cache)) if (key.startsWith(bridgeDir)) delete requireCjs.cache[key];
  try {
    return requireCjs(file);
  } catch (e) {
    if (/Cannot find module 'xlsx'/.test(e.message)) throw new Error("the 'xlsx' package is not installed — run: npm install (then restart npm run planner)");
    throw e;
  }
}
/** Same flags as build-planner's buildServerBridge — one bridge, one shape. */
function transpileBridge(name, src, file) {
  try {
    execFileSync('npx', [
      'tsc', join(root, src),
      '--outDir', bridgeDir, '--rootDir', join(root, 'src'), '--module', 'commonjs', '--target', 'es2020',
      '--moduleResolution', 'node', '--esModuleInterop', '--skipLibCheck',
    ], { cwd: root, stdio: 'pipe' });
    writeFileSync(join(bridgeDir, 'package.json'), '{ "type": "commonjs" }\n');
  } catch (e) {
    throw new Error(`${name} bridge not built — run npm run build:planner (${String(e.stderr || e.message).trim().slice(0, 300)})`);
  }
  if (!existsSync(file)) throw new Error(`${name} bridge not built — run npm run build:planner`);
}
/** What this server process can do — the page compares it with what it expects. */
const SERVER_CAPABILITIES = { version: 6, imports: true, graphs: true, projects: true, personas: true, accounts: true, library: true, record: true, recordings: true };
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
const bridgeDir = join(toolsDir, '.planner-build');
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

// Live reload — DEFERRED while the page says it is mid-dialog (the import
// wizard: creating the project from inside it triggers a rebuild, and a
// reload there closed the window on the owner, 2026-09-02). The page exposes
// window.plannerHoldReload(); the pending reload fires when it lets go.
export const RELOAD_SNIPPET =
  "<script>(function(){window.__plannerReload=function(){if(typeof window.plannerHoldReload==='function'&&window.plannerHoldReload()){window.__plannerReloadPending=true;return false;}location.reload();return true;};" +
  "try{new EventSource('/__reload').addEventListener('message',function(){window.__plannerReload();});}catch(e){}})();</script>";

/** Inject the live-reload listener into served HTML (pure; unit-tested). */
export function injectReload(html) {
  const i = html.lastIndexOf('</body>');
  if (i === -1) return html + RELOAD_SNIPPET;
  return html.slice(0, i) + RELOAD_SNIPPET + html.slice(i);
}

export function contentTypeFor(path) {
  return MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Which planner `/` serves. v1 stays the default until sprint 4 retires it;
 * `PLANNER_V2=1 npm run planner` (or `npm run planner:v2`) opens the new one.
 * Both files are always built and both are always reachable by name.
 */
const DEFAULT_PLANNER = process.env.PLANNER_V2 ? 'journey-planner.html' : 'process-planner.html';

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

  // PLANNER SOURCE only. personas.json, journeys/graphs/ and projects/ used
  // to live here too: editing DATA rebuilt 1.1 MB of HTML and reloaded every
  // open tab. The page reads that data over /__library, /__projects and
  // /__personas now, so a save changes nothing the browser is running.
  const watchTargets = [
    join(toolsDir, 'planner-src.html'),
    join(toolsDir, 'planner-v2'),
    join(toolsDir, 'planner-v2', 'js'),
    join(toolsDir, 'build-planner.mjs'),
    join(root, 'src', 'graph'),
  ];
  for (const target of watchTargets) {
    if (!existsSync(target)) continue;
    try {
      watch(target, { persistent: true }, () => onChange(target.slice(root.length + 1)));
    } catch (e) {
      console.warn(`(watch unavailable for ${target}: ${e.message})`);
    }
  }

  function readPersonasDoc() {
    return JSON.parse(readFileSync(join(dataRoot, 'personas.json'), 'utf8'));
  }
  /** Validate with the SAME rules the suite runs, then write atomically. */
  function writePersonasDoc(doc) {
    const r = bridge('personas').validatePersonas(doc);
    if (!r.ok) throw new Error(`personas.json would be invalid — ${r.errors.join('; ')}`);
    const file = join(dataRoot, 'personas.json');
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
    renameSync(tmp, file);
  }
  function personaRoster(doc = readPersonasDoc()) {
    const lib = bridge('personas');
    return Object.entries(doc.personas ?? {}).map(([id, p]) => {
      const eff = lib.effectivePersona(doc, id) ?? p;
      return { id, role: p.role ?? '', kind: p.kind ?? 'internal', auth: eff.auth ?? '', ...(p.kind !== 'guest' ? { account: lib.accountIdOf(doc, id) } : {}) };
    });
  }
  /**
   * Roles from the test cases → personas.json (the RULES live in
   * src/personas/wiring.ts; this only does the I/O). New accounts get their
   * derived env NAMES appended to .env.example as one block each — the human
   * fills .env.
   */
  function addPersonas(roles, accountByRole = {}) {
    const w = bridge('wiring');
    const requests = roles.map((role) => {
      // The page may key the choice by the role text or by its slug.
      const account = accountByRole[role] ?? accountByRole[w.slugRole(role)];
      return account === undefined ? { role } : { role, account: String(account) };
    });
    const { roster, created, envBlock } = w.addPersonas(readPersonasDoc(), requests);
    if (created.added.length) {
      writePersonasDoc(roster);
      const example = join(dataRoot, '.env.example');
      if (existsSync(example) && created.accountsCreated.length) {
        let text = readFileSync(example, 'utf8');
        const chunks = [];
        for (const account of created.accountsCreated) {
          const lines = envBlock[account].filter((l) => l.startsWith('#') || !new RegExp(`^${l.slice(0, -1)}=`, 'm').test(text));
          if (lines.some((l) => !l.startsWith('#'))) chunks.push(lines.join('\n'));
        }
        if (chunks.length) { text = text.replace(/\n?$/, '\n') + '\n' + chunks.join('\n\n') + '\n'; writeFileSync(example, text); }
      }
    }
    return { ...created, envBlocks: envBlock };
  }
  /** name → isSet booleans for exactly the env names personas.json wires. */
  function envStatus() {
    const status = {};
    try {
      const doc = readPersonasDoc();
      const wiring = personaWiring(doc, bridge('personas'));
      const names = new Set([doc.org?.instanceUrlEnv]);
      for (const s of Object.values(doc.sites ?? {})) names.add(s.urlEnv);
      for (const w of Object.values(wiring)) {
        for (const k of ['username', 'password', 'token', 'totp']) if (w[k]) names.add(w[k]);
      }
      const wanted = [...names].filter(Boolean);
      const envFile = join(dataRoot, '.env');
      // The file is parsed by dotenv itself (src/personas/wiring.ts) — what
      // it says is set is what the run will see. A real process env wins:
      // that is how CI supplies credentials.
      const inFile = bridge('wiring').envPresence(existsSync(envFile) ? readFileSync(envFile, 'utf8') : '', wanted);
      for (const n of wanted) status[n] = !!(process.env[n]?.trim() || inFile[n]);
    } catch { /* empty status — planner shows names without dots */ }
    return status;
  }

  /**
   * POST /__personas — remap ONE persona's credential env NAMES onto the
   * team's existing .env vocabulary. Writes personas.json (names only —
   * .env itself is never touched). Fields: usernameEnv/passwordEnv/
   * tokenEnv/totpEnv ('' clears optional ones) + urlEnv (routes to the
   * persona's site, else the org). The rename rules are wiring.ts's.
   */
  function updatePersonaWiring(body) {
    const lib = bridge('personas');
    const w = bridge('wiring');
    let doc = readPersonasDoc();
    const p = doc.personas?.[body.personaId];
    if (!p) return { code: 404, error: `unknown persona '${body.personaId}'` };
    if (p.kind === 'guest') return { code: 400, error: 'guest personas have no credentials' };
    // The ACCOUNT owns the wiring: a rename is an override on the account,
    // seen by every role that logs in as it. Legacy self-wired personas
    // keep their own fields.
    const accountId = lib.accountIdOf(doc, body.personaId);

    try {
      for (const slot of w.CRED_SLOTS) {
        const key = `${slot}Env`;
        if (!(key in body)) continue;
        doc = w.renameEnvName(doc, accountId, slot, String(body[key] ?? ''));
      }
      if ('urlEnv' in body) {
        const v = String(body.urlEnv ?? '').trim();
        const bad = v ? w.envNameError(v) : 'url env name cannot be empty';
        if (bad) throw new Error(`urlEnv: ${bad}`);
        if (p.site && doc.sites?.[p.site]) doc.sites[p.site].urlEnv = v;
        else doc.org.instanceUrlEnv = v;
      }
      writePersonasDoc(doc);
    } catch (e) { return { code: 400, error: e.message }; }
    const wiring = personaWiring(doc, lib)[body.personaId];
    const warning = !wiring.password && !wiring.token
      ? 'no password or token mapping left — this persona cannot authenticate until one is wired'
      : undefined;
    return {
      code: 200,
      ...(warning ? { warning } : {}),
      wiring,
      // Every role on the same login changed with it — the page refreshes them all.
      wiringAll: personaWiring(doc, lib),
    };
  }

  // ---- the library, read from disk on every call (review §5.3 d) ---------
  /** Shape of /__library; bump when a field's meaning changes. */
  const LIBRARY_VERSION = 1;

  /** One graph file → its library row. An unreadable or invalid graph is
   *  LISTED with its errors — a file you cannot see is a file you cannot fix. */
  function libraryEntry(file, relFile, project) {
    const fallbackId = basename(file).replace(/\.graph\.json$/, '');
    const row = { ref: project ? `${project}/${fallbackId}` : fallbackId, id: fallbackId, title: '', tags: [], sessions: 0, captured: 0, file: relFile };
    let doc;
    try { doc = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { ...row, invalid: [`unreadable: ${e.message}`] }; }
    if (!doc || typeof doc !== 'object') return { ...row, invalid: ['graph must be an object'] };
    const id = typeof doc.id === 'string' && doc.id ? doc.id : fallbackId;
    // Sessions, and how many of them have been recorded — the same count the
    // planner puts on its status line.
    const sessions = (Array.isArray(doc.nodes) ? doc.nodes : []).filter((n) => n && n.type === 'session');
    const v = bridge('schema').validateGraph(doc);
    return {
      ref: project ? `${project}/${id}` : id,
      id,
      title: typeof doc.title === 'string' ? doc.title : '',
      tags: Array.isArray(doc.tags) ? doc.tags.filter((t) => typeof t === 'string') : [],
      sessions: sessions.length,
      captured: sessions.filter((n) => n.steps && n.steps.status === 'captured').length,
      file: relFile,
      ...(v.ok ? {} : { invalid: v.errors }),
    };
  }
  /** Every *.graph.json in one directory, sorted, as library rows. */
  function graphsIn(dir, project, relDir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.graph.json')).sort()
      .map((f) => libraryEntry(join(dir, f), `${relDir}/${f}`, project));
  }
  /**
   * suites.json as the planner's Suites pane reads it (src/suites.ts owns the
   * meaning; this is I/O only). A malformed or missing file is an EMPTY set,
   * never a 500: the library must stay listable while a suite is half-typed.
   */
  function readSuites() {
    try {
      const doc = JSON.parse(readFileSync(join(dataRoot, 'suites.json'), 'utf8'));
      if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return {};
      const out = {};
      for (const [name, def] of Object.entries(doc)) {
        if (!def || typeof def !== 'object' || Array.isArray(def)) continue;
        out[name] = {
          ...(Array.isArray(def.graphs) ? { graphs: def.graphs.filter((g) => typeof g === 'string') } : {}),
          ...(Array.isArray(def.tags) ? { tags: def.tags.filter((t) => typeof t === 'string') } : {}),
          ...(typeof def.project === 'string' ? { project: def.project } : {}),
        };
      }
      return out;
    } catch { return {}; }
  }

  /**
   * recordings/<journey>/<persona>-<YYYYMMDD-HHMMSS>/ — what `npm run record`
   * left behind, so the planner's "From a recording" sheet can name the
   * journey the pipeline command needs. manifest.json is the truth when it is
   * readable (persona + startedAt as the recorder wrote them); the directory
   * name is the fallback. Nothing here runs the pipeline — the planner hands
   * the human the command.
   */
  function readRecordings() {
    const base = join(dataRoot, 'recordings');
    if (!existsSync(base)) return [];
    const out = [];
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(base, entry.name);
      const runs = [];
      for (const run of readdirSync(dir, { withFileTypes: true })) {
        if (!run.isDirectory()) continue;
        const m = /^(.*)-(\d{8}-\d{6})$/.exec(run.name);
        let persona = m ? m[1] : run.name;
        let at = m ? m[2] : '';
        try {
          const manifest = JSON.parse(readFileSync(join(dir, run.name, 'manifest.json'), 'utf8'));
          if (typeof manifest.persona === 'string' && manifest.persona) persona = manifest.persona;
          if (typeof manifest.startedAt === 'string' && manifest.startedAt) at = manifest.startedAt;
        } catch { /* no manifest (or a half-written one): the name still says who and when */ }
        runs.push({ dir: `recordings/${entry.name}/${run.name}`, persona, at });
      }
      if (!runs.length) continue;
      runs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
      out.push({ journey: entry.name, runs, latest: runs[runs.length - 1].at });
    }
    return out.sort((a, b) => a.journey.localeCompare(b.journey));
  }

  function readLibrary() {
    const projects = listProjects(dataRoot).map((p) => ({
      name: p.project,
      graphs: graphsIn(join(dataRoot, 'projects', p.project, 'graphs'), p.project, `projects/${p.project}/graphs`),
    }));
    return {
      version: LIBRARY_VERSION,
      projects,
      legacy: graphsIn(join(dataRoot, 'journeys', 'graphs'), null, 'journeys/graphs'),
      suites: readSuites(),
    };
  }
  /** `project/id`, or a bare id (legacy, or unambiguous) → its library row. */
  function findGraph(project, journey) {
    const all = [];
    const lib = readLibrary();
    for (const p of lib.projects) all.push(...p.graphs);
    all.push(...lib.legacy);
    const wanted = journey.includes('/') ? journey : project ? `${project}/${journey}` : journey;
    return all.find((g) => g.ref === wanted) ?? (wanted === journey ? all.find((g) => g.id === journey) : undefined);
  }

  // ---- recording runs (review §7: the planner starts `npm run record`) ---
  // The child is a plain `npm run record` with RECORD_PERSONA/RECORD_JOURNEY
  // in its environment — the SAME command a human types, so there is no
  // second way to record. PLANNER_RECORD_CMD replaces it (tests point it at
  // a script that exits without opening a browser). RECORD_PROJECT is NOT
  // passed: parseRecordEnv (src/pipeline/recording.ts) knows journey ids
  // only, so `project` here just resolves WHICH graph is meant.
  const RECORD_TAIL = 40;
  const recordings = new Map();
  let recordSeq = 0;

  function startRecording(target, persona) {
    const argv = String(process.env.PLANNER_RECORD_CMD || 'npm run record').split(/\s+/).filter(Boolean);
    if (!argv.length) throw new Error('PLANNER_RECORD_CMD is empty — unset it to use `npm run record`');
    const id = `rec_${Date.now().toString(36)}_${++recordSeq}`;
    const run = { id, ref: target.ref, journey: target.id, persona, pid: 0, status: 'running', exitCode: null, tail: [] };
    const tail = (text) => {
      for (const line of String(text).split('\n')) {
        if (!line.trim()) continue;
        run.tail.push(line);
        if (run.tail.length > RECORD_TAIL) run.tail.shift();
      }
    };
    // detached:false — the recorder stays in the server's process group, so
    // Ctrl+C on `npm run planner` stops the headed browser with it.
    const child = spawn(argv[0], argv.slice(1), {
      cwd: root,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, RECORD_PERSONA: persona, RECORD_JOURNEY: target.id },
    });
    run.pid = child.pid ?? 0;
    child.stdout.on('data', tail);
    child.stderr.on('data', tail);
    child.on('error', (e) => { run.status = 'failed'; tail(`spawn failed: ${e.message}`); });
    child.on('close', (code) => {
      run.exitCode = code ?? -1;
      if (run.status === 'running') run.status = code === 0 ? 'done' : 'failed';
    });
    recordings.set(id, run);
    return run;
  }
  const recordStatus = (run) => ({
    ok: true, id: run.id, ref: run.ref, journey: run.journey, persona: run.persona,
    status: run.status, ...(run.exitCode === null ? {} : { exitCode: run.exitCode }), tail: run.tail,
  });

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
    if (url.pathname === '/__capabilities') {
      sendJson(res, 200, SERVER_CAPABILITIES);
      return;
    }
    // ---- the graph library, fresh from disk (no rebuild, no reload) ------
    // GET /__library → { ok, version, projects: [{name, graphs: [row]}], legacy: [row] }
    //   row = { ref, id, title, tags[], sessions, captured, file, invalid?[] }
    // The page calls this after every save instead of being reloaded under
    // its own feet (review §5.3 d).
    if (url.pathname === '/__library' && req.method === 'GET') {
      try { sendJson(res, 200, { ok: true, ...readLibrary() }); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      return;
    }
    // GET /__recordings → { ok, recordings: [{journey, latest, runs:[{dir, persona, at}]}] }
    // The planner's "From a recording" door: which journeys have captures, so
    // it can hand over `PIPELINE_JOURNEY=<id> PIPELINE_GRAPH=1 npm run pipeline`.
    if (url.pathname === '/__recordings' && req.method === 'GET') {
      try { sendJson(res, 200, { ok: true, recordings: readRecordings() }); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      return;
    }
    // ---- recording: POST /__record {persona, journey, project?} ----------
    // → 200 { ok, id, pid, ref, persona } · 409 { ok:false, running:true, id }
    // when that journey is already recording · 400 on an unknown persona or
    // journey. GET /__record/<id> → { ok, id, ref, journey, persona,
    // status:'running'|'done'|'failed', exitCode?, tail: [last 40 lines] }.
    // Poll it; there is no second event stream to keep alive.
    if (url.pathname === '/__record' && req.method === 'POST') {
      readJson(req, 10_000).then((body) => {
        try {
          const persona = String(body.persona ?? '').trim();
          const roster = knownPersonas();
          if (!roster.includes(persona)) throw new Error(`unknown persona '${persona}' — personas.json has: ${roster.join(', ') || '(none)'}`);
          const journey = String(body.journey ?? '').trim();
          if (!journey) throw new Error('journey: name the graph to record');
          const project = String(body.project ?? '').trim();
          const target = findGraph(project, journey);
          if (!target) throw new Error(`unknown journey '${project ? `${project}/${journey}` : journey}' — no graph with that ref`);
          const live = [...recordings.values()].find((r) => r.ref === target.ref && r.status === 'running');
          if (live) {
            sendJson(res, 409, { ok: false, running: true, id: live.id, error: `'${target.ref}' is already recording as '${live.persona}' — finish that session first` });
            return;
          }
          const run = startRecording(target, persona);
          sendJson(res, 200, { ok: true, id: run.id, pid: run.pid, ref: run.ref, persona });
        } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }
    if (url.pathname.startsWith('/__record/') && req.method === 'GET') {
      const run = recordings.get(url.pathname.slice('/__record/'.length));
      if (!run) { sendJson(res, 404, { ok: false, error: 'no recording with that id (the server restarted?)' }); return; }
      sendJson(res, 200, recordStatus(run));
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
        sendJson(res, 200, { ok: true, imports: bridge('imports').listImports(dataRoot, project) });
      } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (url.pathname === '/__imports' && req.method === 'POST') {
      readJson(req, 25_000_000).then((body) => {
        try {
          const data = Buffer.from(String(body.contentBase64 ?? ''), 'base64');
          if (!data.length) throw new Error('empty file');
          const { manifest, skippedSheets } = bridge('imports').storeImport(dataRoot, String(body.project ?? ''), String(body.filename ?? 'import.csv'), data);
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
          const { manifest, results } = bridge('imports').applyImport(
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
          const { validateGraph } = bridge('schema');
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
          // NO rebuild here: a saved graph is DATA. The page has the ref in
          // this response and re-reads /__library — reloading the app the
          // author is working in (and recovering it from a sessionStorage
          // breadcrumb) was the cost of inlining the library at build time.
          sendJson(res, 200, { ok: true, ref: `${project}/${id}`, file: `projects/${project}/graphs/${id}.graph.json`, overwritten: !!body.overwrite });
        } catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      }).catch((e) => sendJson(res, 400, { ok: false, error: e.message }));
      return;
    }
    // ---- personas: roles → accounts → env (docs/DESIGN-ROLES-ACCOUNTS.md) ----
    // GET  /__personas → { ok, roster: [{id, role, kind, auth, account}], accounts: [{id, system, auth, roles[]}], wiring: {id → env NAMES} }
    // POST /__personas/add {roles[], accounts?: {role → accountId}}
    //      → { ok, added[], existing[], bound{}, accountsCreated[], envBlocks{}, roster[], accounts[] }
    //   role name → persona id (lower_snake_case) bound to an account: the
    //   one chosen per role (existing or new), else a new account named after
    //   the role. New accounts' derived env NAMES go to .env.example as one
    //   block each; values are never touched.
    if (url.pathname === '/__personas' && req.method === 'GET') {
      try { const doc = readPersonasDoc(); const lib = bridge('personas'); sendJson(res, 200, { ok: true, roster: personaRoster(doc), accounts: accountList(doc, lib), wiring: personaWiring(doc, lib) }); }
      catch (e) { sendJson(res, 400, { ok: false, error: e.message }); }
      return;
    }
    if (url.pathname === '/__personas/add' && req.method === 'POST') {
      readJson(req, 100_000).then((body) => {
        try {
          const roles = Array.isArray(body.roles) ? body.roles.map((r) => String(r).trim()).filter(Boolean) : [];
          if (!roles.length) throw new Error('roles: give at least one role name');
          const accountByRole = body.accounts && typeof body.accounts === 'object' ? body.accounts : {};
          const out = addPersonas(roles, accountByRole);
          rebuild(`personas added: ${out.added.join(', ') || '(none)'}`);
          const doc = readPersonasDoc();
          const lib = bridge('personas');
          sendJson(res, 200, { ok: true, ...out, roster: personaRoster(doc), accounts: accountList(doc, lib), wiring: personaWiring(doc, lib) });
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
          ? { ok: true, wiring: out.wiring, wiringAll: out.wiringAll, envstatus: envStatus(), ...(out.warning ? { warning: out.warning } : {}) }
          : { ok: false, error: out.error }));
      });
      return;
    }
    const rel = url.pathname === '/' ? `/${DEFAULT_PLANNER}` : url.pathname;
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
    console.log(`process planner → http://127.0.0.1:${actual}/${DEFAULT_PLANNER}`);
    if (!process.env.PLANNER_V2) console.log(`journey script planner (v2) → http://127.0.0.1:${actual}/journey-planner.html   (PLANNER_V2=1 makes it the default)`);
    console.log('watching planner-src.html, planner-v2/, build-planner.mjs, src/graph/ — planner-source edits rebuild + live-reload. Saved graphs do not (the page re-reads /__library). Ctrl+C to stop.');
  });
}
