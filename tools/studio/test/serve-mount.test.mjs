import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStudioHandler, sanitizeRel, FEATURES } from '../lib/serve.mjs';

/**
 * The HTTP surface as a handler another server MOUNTS under a prefix —
 * same origin as the host site, no second process. The host strips its
 * prefix and hands over the rest; every page URL is relative so the UI
 * works at `/` and at `/studio/` alike.
 */
/** fetch() normalises `..` away before sending — a raw request does not. */
function rawStatus(base, p) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = httpRequest({ host: u.hostname, port: u.port, path: p, method: 'GET' }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    r.on('error', reject); r.end();
  });
}

async function withMounted(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'js-mount-'));
  const root = path.join(dir, 'guides');
  mkdirSync(path.join(root, 'b1', 'crm--x--default'), { recursive: true });
  writeFileSync(path.join(root, 'b1', 'crm--x--default', 'guide.json'), JSON.stringify({ objective: 'crm--x--default', title: 'X', steps: [] }));
  writeFileSync(path.join(root, 'b1', 'crm--x--default', 'raw.webm'), Buffer.from('0123456789'));
  writeFileSync(path.join(root, 'index.json'), JSON.stringify({ schema: 'journey-index/v1', batches: [{ id: 'b1', results: { passed: 1, failed: 0, skipped: 0, flaky: 0, total: 1 }, tests: [{ title: 'crm/x', outcome: 'passed', slug: 'crm--x--default' }], guides: [] }] }));
  const studio = createStudioHandler({ root });
  const host = createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/studio') { res.writeHead(301, { location: '/studio/' }); res.end(); return; }
    if (u.pathname.startsWith('/studio/')) { studio(req, res, u.pathname.slice('/studio'.length)).catch(() => { res.writeHead(500); res.end(); }); return; }
    // the host's own site: only `/` exists — so a traversal that escapes the
    // mount lands on a 404 here, never on a real file
    if (u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('host site'); return; }
    res.writeHead(404); res.end('host 404');
  });
  await new Promise((r) => host.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${host.address().port}`;
  try { await fn(base, root); }
  finally { host.close(); rmSync(dir, { recursive: true, force: true }); }
}

test('mounted under /studio/: pages, api, batch files and Range all answer under the prefix; the host keeps the rest', async () => {
  await withMounted(async (base, root) => {
    assert.equal(await (await fetch(`${base}/`)).text(), 'host site');
    const dash = await fetch(`${base}/studio/`);
    assert.equal(dash.status, 200);
    const html = await dash.text();
    assert.match(html, /dashboard/i);
    assert.doesNotMatch(html, /['"`]\/api\//, 'pages must not hard-code /api/ — relative only, or the mount breaks');
    const studioPage = await (await fetch(`${base}/studio/studio.html?batch=b1&slug=crm--x--default`)).text();
    assert.match(studioPage, /q\.get\('slug'\)/);
    assert.doesNotMatch(studioPage, /['"`]\/api\//);
    const health = await (await fetch(`${base}/studio/api/health`)).json();
    assert.deepEqual(health, { ok: true, features: FEATURES });
    assert.ok(FEATURES.includes('mount'));
    const guide = await (await fetch(`${base}/studio/b1/crm--x--default/guide.json`)).json();
    assert.equal(guide.objective, 'crm--x--default');
    const idx = await (await fetch(`${base}/studio/index.json`)).json();
    assert.equal(idx.batches[0].id, 'b1');
    const range = await fetch(`${base}/studio/b1/crm--x--default/raw.webm`, { headers: { range: 'bytes=2-4' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '234');
    const review = await fetch(`${base}/studio/api/review?batch=b1&filter=passed`);
    assert.equal(review.headers.get('content-type'), 'text/markdown; charset=utf-8');
    // a note round-trips into the mounted root
    const note = await (await fetch(`${base}/studio/api/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ batch: 'b1', slug: 'crm--x--default', text: 'rename step 2', tag: 'rename' }) })).json();
    assert.equal(note.text, 'rename step 2');
    assert.equal(JSON.parse(readFileSync(path.join(root, 'feedback.json'), 'utf8')).length, 1);
  });
});

test('mounted: traversal out of the guides dir is refused, a directory is not a file', async () => {
  await withMounted(async (base) => {
    for (const p of ['/studio/../package.json', '/studio/%2e%2e/package.json', '/studio/b1/../../package.json', '/studio/b1/../../../lib/serve.mjs']) {
      assert.notEqual(await rawStatus(base, p), 200, p);
    }
    assert.equal((await fetch(`${base}/studio/b1`)).status, 404);
    assert.equal((await fetch(`${base}/studio/nope.json`)).status, 404);
    // POST anywhere but voice.webm is forbidden
    assert.equal((await fetch(`${base}/studio/b1/crm--x--default/guide.json`, { method: 'POST', body: '{}' })).status, 403);
  });
});

test('sanitizeRel: traversal and absolute paths are rejected', () => {
  assert.equal(sanitizeRel('a/b.webm'), 'a/b.webm');
  assert.equal(sanitizeRel('/abs/x'), 'abs/x');
  assert.equal(sanitizeRel('../x'), null);
  assert.equal(sanitizeRel('a/../../x'), null);
  assert.equal(sanitizeRel(''), null);
});
