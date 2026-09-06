// serve — the HTTP surface as a MOUNTABLE handler.
//
// `journey-studio serve` is one way to run it; another server can mount the
// same handler under a prefix (`/studio/`) and Journey Studio becomes part of
// that site — same origin, no second process, no CORS. Every URL the pages
// use is RELATIVE (`api/health`, `index.json`, `<batch>/<slug>/guide.json`),
// so they work at `/` and at `/studio/` alike. The handler is given the path
// with the mount prefix already stripped.
import { readFileSync, writeFileSync, mkdirSync, existsSync, createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReview } from './brief.mjs';
import { ingestFolder, writeIndex, removeBatch, removeGuide } from './ingest.mjs';
import { newNote, addNote, updateNote, removeNote } from './feedback.mjs';

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WEB_DIR = path.join(PKG, 'web');
export const FEATURES = ['range', 'live-web', 'remove', 'upload', 'ingest', 'notes', 'health', 'review', 'mount'];

export const TYPES = { '.html': 'text/html', '.json': 'application/json', '.webm': 'video/webm', '.mp4': 'video/mp4', '.js': 'text/javascript', '.css': 'text/css', '.srt': 'text/plain', '.vtt': 'text/vtt', '.md': 'text/markdown; charset=utf-8' };

const nowIso = () => new Date().toISOString();

/** A relative path a client may write under inbox/: no traversal, no absolute. PURE. */
export function sanitizeRel(rel) {
  const norm = path.posix.normalize(String(rel).replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!norm || norm === '.' || norm.startsWith('../') || norm.includes('/../') || norm === '..') return null;
  return norm;
}

export function readBody(req) {
  return new Promise((resolve, reject) => { const p = []; req.on('data', (c) => p.push(c)); req.on('end', () => resolve(Buffer.concat(p))); req.on('error', reject); });
}

/**
 * @param {object} o
 * @param {string} o.root     the guides dir (batches, index.json, feedback.json)
 * @param {string} [o.inbox]  drop-zone staging dir (default: sibling `inbox/` of root)
 * @param {string} [o.openapi] OpenAPI spec path for HTTP-triggered ingests
 * @param {string} [o.web]    where dashboard/studio/feedback.html live (default: this package's web/)
 * @returns {(req, res, pathname?: string) => Promise<void>}  `pathname` defaults to the request URL's path
 */
export function createStudioHandler({ root: rootDir, inbox, openapi = null, web = WEB_DIR }) {
  const root = path.resolve(rootDir);
  const INBOX = path.resolve(inbox ?? path.join(root, '..', 'inbox'));
  const OPENAPI = openapi ? path.resolve(openapi) : null;
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

  return async function studio(req, res, mountedPath) {
    const u = new URL(req.url, 'http://localhost');
    let pathname = mountedPath ?? decodeURIComponent(u.pathname);
    if (!pathname.startsWith('/')) pathname = '/' + pathname;

    // ── drop zone: stage one uploaded file into inbox/<rel> ──
    if (req.method === 'PUT' && pathname === '/api/upload') {
      const safe = sanitizeRel(u.searchParams.get('path') || '');
      if (!safe) { res.writeHead(400); res.end('bad path'); return; }
      const dest = path.join(INBOX, safe);
      if (!dest.startsWith(INBOX + path.sep)) { res.writeHead(403); res.end('forbidden'); return; }
      try { const body = await readBody(req); mkdirSync(path.dirname(dest), { recursive: true }); writeFileSync(dest, body); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    // ── drop zone: ingest a staged batch, refresh the index ──
    if (req.method === 'POST' && pathname === '/api/ingest') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const src = batch && path.join(INBOX, batch);
      if (!batch || !existsSync(src)) { json(res, 404, { error: 'no staged files for that batch' }); return; }
      try {
        const entry = ingestFolder(src, { out: root, openapiPath: OPENAPI, batchId: batch, now: nowIso() });
        writeIndex(root, entry);
        json(res, 200, entry);
      } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
      return;
    }
    // ── health/version: lets the live-served UI detect an OUTDATED server process ──
    if (req.method === 'GET' && pathname === '/api/health') { json(res, 200, { ok: true, features: FEATURES }); return; }
    // ── AI review pack: a FILTERED result set as one markdown fetch ──
    if (req.method === 'GET' && pathname === '/api/review') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const f = u.searchParams.get('filter') || 'all';
      const filter = ['all', 'passed', 'failed', 'skipped'].includes(f) ? f : 'all';
      let index = null; try { index = JSON.parse(readFileSync(path.join(root, 'index.json'), 'utf8')); } catch {}
      const entry = index && (index.batches || []).find((b) => b.id === batch);
      if (!entry) { json(res, 404, { error: 'unknown batch' }); return; }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'no-store' });
      res.end(buildReview(entry, filter));
      return;
    }
    // ── soft-remove: move a batch or one guide into guides/_to_delete/ ──
    if (req.method === 'POST' && pathname === '/api/remove') {
      const batch = (u.searchParams.get('batch') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      const slug = (u.searchParams.get('slug') || '').replace(/[^a-zA-Z0-9._-]/g, '-');
      try {
        const result = slug ? removeGuide(root, batch, slug, nowIso()) : removeBatch(root, batch, nowIso());
        if (!result) { json(res, 404, { error: 'not found' }); return; }
        json(res, 200, result);
      } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
      return;
    }
    // ── feedback loop: work-to-do notes (guides/feedback.json) ──
    if (req.method === 'POST' && pathname.startsWith('/api/note')) {
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
        const fp = path.join(root, 'feedback.json');
        let list = []; try { list = JSON.parse(readFileSync(fp, 'utf8')); } catch {}
        const now = nowIso(); let result;
        if (pathname === '/api/note') { const nt = newNote({ ...body, now }); list = addNote(list, nt); result = nt; }
        else if (pathname === '/api/note/update') { list = updateNote(list, body.id, body.patch || {}, now); result = { ok: true }; }
        else if (pathname === '/api/note/delete') { list = removeNote(list, body.id); result = { ok: true }; }
        else { res.writeHead(404); res.end('no'); return; }
        mkdirSync(root, { recursive: true });
        writeFileSync(fp, JSON.stringify(list, null, 2));
        json(res, 200, result);
      } catch (e) { json(res, 500, { error: String(e && e.message || e) }); }
      return;
    }
    // ── studio save-back: the recorded narration ──
    if (req.method === 'POST') {
      const target = path.join(root, pathname);
      if (!target.startsWith(root + path.sep) || path.basename(target) !== 'voice.webm') { res.writeHead(403); res.end('forbidden'); return; }
      try { const body = await readBody(req); mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, body); writeFileSync(path.join(path.dirname(target), 'state.json'), JSON.stringify({ state: 'narrated' }, null, 2)); res.writeHead(200); res.end('ok'); }
      catch (e) { res.writeHead(500); res.end(String(e)); }
      return;
    }
    // ── static GET — with HTTP Range support ──
    // Range matters: without 206 responses Chrome's <video> has an EMPTY seekable
    // range for anything not yet buffered, so timeline clicks and step jumps
    // silently snap back to 0 on long recordings. Narration is built on scrubbing.
    let p = pathname;
    if (p === '/') p = '/dashboard.html';
    let file = path.join(root, p);
    // The UI pages are ALWAYS served live from web/ — the copyWeb copies in the
    // guides dir are only for portability (other static servers).
    const pageName = path.posix.basename(p);
    if (/^(dashboard|studio|feedback)\.html$/.test(pageName)) {
      const live = path.join(web, pageName);
      if (existsSync(live)) file = live;
    }
    if ((!file.startsWith(root + path.sep) && !file.startsWith(path.join(web) + path.sep)) || !existsSync(file) || statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    const size = statSync(file).size;
    const m = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (m && (m[1] || m[2])) {
      const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10));
      const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
      if (start >= size || start > end) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
      res.writeHead(206, { 'content-type': type, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
      pipeline(createReadStream(file, { start, end }), res, () => {});   // aborted seeks must not kill the process
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    pipeline(createReadStream(file), res, () => {});
  };
}
