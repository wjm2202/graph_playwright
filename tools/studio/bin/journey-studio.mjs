#!/usr/bin/env node
/**
 * journey-studio — turn Playwright test results into narrated how-to guides.
 *
 *   journey-studio <results.json>                     build one report + open dashboard
 *   journey-studio build <results.json> [--out ./guides]
 *   journey-studio ingest [--inbox ./inbox] [--out ./guides] [--openapi <spec.json>]
 *   journey-studio ingest --from <report-folder> [--batch <id>] [--openapi <spec.json>]
 *   journey-studio serve [--dir ./guides] [--port 8777]
 *   journey-studio splice <slug> [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]
 *
 * DROP MODEL: drop a Playwright report folder onto the dashboard (or `ingest --from`).
 * Each folder becomes a BATCH under guides/<id>/, recorded in guides/index.json — the
 * browsable folder index. The dashboard drop zone uploads files to /api/upload then
 * triggers /api/ingest, both served here.
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFromReport } from '../lib/build-core.mjs';
import { enrichGuide, enrichStats, scrubText } from '../lib/enrich.mjs';
import { chaptersWithActions } from '../lib/trace-actions.mjs';
import { buildBrief } from '../lib/brief.mjs';
import { extractNetworkText, extractTraceText, ingestFolder, ingestInbox, writeIndex } from '../lib/ingest.mjs';
import { createStudioHandler } from '../lib/serve.mjs';
import { splice } from '../lib/splice.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(__dirname, '..');
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--out') a.out = argv[++i];
    else if (t === '--dir') a.dir = argv[++i];
    else if (t === '--inbox') a.inbox = argv[++i];
    else if (t === '--from') a.from = argv[++i];
    else if (t === '--batch') a.batch = argv[++i];
    else if (t === '--openapi') a.openapi = argv[++i];
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t === '--host') a.host = argv[++i];
    else if (t === '--rate') a.rate = Number(argv[++i]);
    else if (t === '--band') a.band = Number(argv[++i]);
    else if (t === '--fps') a.fps = Number(argv[++i]);
    else if (t === '--crf') a.crf = argv[++i];
    else if (t === '--preset') a.preset = argv[++i];
    else if (t === '--add-intro') a.addIntro = argv[++i];
    else if (t === '--intro') a.intro = argv[++i];
    else if (t === '--no-serve') a.serve = false;
    else if (t === '--no-open') a.open = false;   // serve without launching a browser (a dev server that links here has its own tab)
    else a._.push(t);
  }
  return a;
}

function ffprobeMs(file) {
  try {
    const s = parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]).toString().trim());
    return Number.isFinite(s) ? Math.round(s * 1000) : 0;
  } catch { return 0; }
}

function copyWeb(outDir) {
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(PKG, 'web', 'dashboard.html'), path.join(outDir, 'dashboard.html'));
  copyFileSync(path.join(PKG, 'web', 'studio.html'), path.join(outDir, 'studio.html'));
  try { copyFileSync(path.join(PKG, 'web', 'feedback.html'), path.join(outDir, 'feedback.html')); } catch {}
}


function build(resultsPath, outDir, openapiPath) {
  if (!existsSync(resultsPath)) { console.error(`✗ no results file at ${resultsPath}`); process.exit(1); }
  const report = JSON.parse(readFileSync(resultsPath, 'utf8'));
  const openapi = openapiPath && existsSync(openapiPath) ? JSON.parse(readFileSync(openapiPath, 'utf8')) : null;

  const durations = {};
  let missing = 0;
  for (const g of buildFromReport(report).guides) {
    const dir = path.join(outDir, g.slug);
    mkdirSync(dir, { recursive: true });
    if (g.videoPath && existsSync(g.videoPath)) { const dest = path.join(dir, 'raw.webm'); copyFileSync(g.videoPath, dest); durations[g.slug] = ffprobeMs(dest); }
    else if (g.videoPath) missing++;
    if (g.tracePath && existsSync(g.tracePath)) copyFileSync(g.tracePath, path.join(dir, 'trace.zip'));
  }

  const { guides, registry } = buildFromReport(report, { durations });
  for (const g of guides) {
    const dir = path.join(outDir, g.slug);
    let bundle = {
      objective: g.slug, title: g.meta.title, category: g.meta.category ?? 'uncategorized',
      assumes: g.meta.assumes ?? [], journeyRef: g.meta.journeyRef ?? null, specFile: g.file ?? null,
      annotated: g.annotated, video: g.videoPath ? `${g.slug}/raw.webm` : null,
      durationMs: g.durationMs, aligned: g.aligned, steps: g.steps,
    };
    const traceZip = path.join(dir, 'trace.zip');
    const networkText = extractNetworkText(traceZip);
    let t0;
    if (!bundle.steps.length) {                    // mirror of ingestFolder's trace-mining path
      const { chapters, t0: videoStart } = chaptersWithActions(extractTraceText(traceZip), { videoMs: durations[g.slug] || 0 });
      bundle.steps = chapters.map((c) => ({
        id: c.id, index: c.index, title: c.title, hint: c.hint ?? null, ...(c.post ? { post: true } : {}),
        startMs: c.startMs, endMs: c.endMs, testId: null,
        assertions: c.assertions ?? [], checks: c.checks ?? [], sees: c.sees ?? null,
        messages: c.messages ?? [], actions: c.actions ?? [], downstream: [],
        console: (c.console ?? []).map((e) => ({ ...e, text: scrubText(e.text) })), narration: null,
      }));
      t0 = videoStart;
    }
    bundle = enrichGuide(bundle, { networkText, openapi, startMs: t0 });
    const ds = enrichStats(bundle);
    writeFileSync(path.join(dir, 'guide.json'), JSON.stringify(bundle, null, 2));
    writeFileSync(path.join(dir, 'narration-brief.md'), buildBrief(bundle, { fingerprint: g.fingerprint }));
    writeFileSync(path.join(dir, 'journey.fingerprint.json'), JSON.stringify(
      { schema: 'journey-fingerprint/v1', slug: g.slug, hash: g.fingerprint, steps: g.steps.map((s) => ({ title: s.title, testId: s.testId, assertions: s.assertions })) }, null, 2));
    console.log(`  ${g.annotated ? '★' : '·'} ${g.slug}  ${g.steps.length} steps  ${g.durationMs}ms  aligned=${g.aligned}  downstream=${ds.total}`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, 'registry.json'), JSON.stringify(registry, null, 2));
  copyWeb(outDir);
  console.log(`\n✓ ${Object.keys(registry).length} guide(s) → ${outDir}${missing ? `  (${missing} video path(s) not found here — run where the tests ran)` : ''}`);
  return outDir;
}

function ingest(args) {
  const out = path.resolve(args.out ?? 'guides');
  const openapiPath = args.openapi ? path.resolve(args.openapi) : null;
  const now = nowIso();
  const opts = { out, openapiPath, now, log: (m) => console.log(m) };
  let entries;
  if (args.from) {
    console.log(`▒ ingesting folder ${args.from}`);
    const entry = ingestFolder(path.resolve(args.from), { ...opts, batchId: args.batch });
    writeIndex(out, entry);
    entries = [entry];
  } else {
    const inbox = path.resolve(args.inbox ?? 'inbox');
    if (!existsSync(inbox)) { console.error(`✗ no inbox at ${inbox} — create it and drop Playwright report folders inside, or use --from <folder>`); process.exit(1); }
    console.log(`▒ scanning inbox ${inbox}`);
    entries = ingestInbox(inbox, opts);
  }
  copyWeb(out);
  const guides = entries.reduce((n, e) => n + e.guideCount, 0);
  console.log(`\n✓ ${entries.length} folder(s), ${guides} guide(s) → ${out}`);
  for (const e of entries) console.log(`   • ${e.id}  (${e.guideCount} guide${e.guideCount === 1 ? '' : 's'})${e.missingVideos ? `  ⚠ ${e.missingVideos} video(s) not found here` : ''}`);
  if (args.serve !== false) serve(out, args.port ?? 8777, args.host);
  return out;
}

function serve(dir, port, host = '127.0.0.1', tries = 0) {
  const root = path.resolve(dir);
  const INBOX = path.resolve(root, '..', 'inbox');           // drop-zone staging (sibling of guides/)
  const OPENAPI = process.env.JOURNEY_OPENAPI ? path.resolve(process.env.JOURNEY_OPENAPI) : null;
  copyWeb(root);                                             // ensure the dashboard is always present

  // The whole HTTP surface lives in lib/serve.mjs so another server can
  // mount it under a prefix (same origin, no second process).
  const handler = createStudioHandler({ root, inbox: INBOX, openapi: OPENAPI });
  const server = createServer((req, res) => { handler(req, res).catch((e) => { try { res.writeHead(500); res.end(String(e && e.message || e)); } catch {} }); });
  // SURVIVE, don't die: Range support means every video seek ABORTS the previous
  // request — a closed socket mid-stream raised unhandled 'error' events that
  // killed the whole server (seen in prod: dashboard drop-upload hit
  // ERR_CONNECTION_REFUSED because a seek had crashed the process minutes earlier).
  server.on('clientError', (e, socket) => { try { socket.destroy(); } catch {} });
  if (!globalThis.__jsGuards) {
    globalThis.__jsGuards = true;   // serve() recurses on EADDRINUSE — register once
    process.on('uncaughtException', (e) => console.error(`✗ server error (survived): ${e.message}`));
    process.on('unhandledRejection', (e) => console.error(`✗ server rejection (survived): ${e && e.message || e}`));
  }
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries < 12) { console.log(`  :${port} in use — trying :${port + 1}…`); serve(dir, port + 1, host, tries + 1); }
    else { console.error(`✗ serve failed on :${port}: ${e.message}  (free it: lsof -ti tcp:${port} | xargs kill)`); process.exit(1); }
  });
  server.listen(port, host, () => {
    const url = `http://localhost:${port}/dashboard.html`;
    console.log(`▶ dashboard → ${url}  (serving ${root} — drop report folders on the page — Ctrl-C to stop)`);
    if (!OPEN_BROWSER) return;
    const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref(); } catch {}
  });
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
// --no-open: every serve() path (serve, ingest, bare <results.json>) honours it
const OPEN_BROWSER = args.open !== false;
if (cmd === 'build') {
  build(path.resolve(args._[1] ?? 'results.json'), path.resolve(args.out ?? 'guides'), args.openapi ? path.resolve(args.openapi) : null);
} else if (cmd === 'ingest') {
  ingest(args);
} else if (cmd === 'serve') {
  serve(args.dir ?? 'guides', args.port ?? 8777, args.host);
} else if (cmd === 'splice') {
  if (!args._[1]) { console.error('usage: journey-studio splice <slug> [--dir ./guides] [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]'); process.exit(1); }
  splice(args._[1], { dir: args.dir, rate: args.rate, band: args.band, fps: args.fps, crf: args.crf, preset: args.preset, addIntro: args.addIntro, intro: args.intro });
} else if (cmd && cmd.endsWith('.json')) {
  const out = build(path.resolve(cmd), path.resolve(args.out ?? 'guides'), args.openapi ? path.resolve(args.openapi) : null);
  serve(out, args.port ?? 8777, args.host);
} else {
  console.log('usage:\n  journey-studio <results.json>                       build one report + open dashboard\n  journey-studio build <results.json> [--out ./guides] [--openapi <spec.json>]\n  journey-studio ingest [--inbox ./inbox] [--openapi <spec.json>]   drop-folder ingest → index\n  journey-studio ingest --from <report-folder> [--batch <id>]\n  journey-studio serve [--dir ./guides] [--port 8777] [--host 127.0.0.1] [--no-open]\n  journey-studio splice <slug> [--rate 1.75] [--add-intro <add_intro.sh>] [--intro <intro.mp4>]');
  process.exit(cmd ? 1 : 0);
}
