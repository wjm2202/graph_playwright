import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildFromReport } from '../lib/build-core.mjs';
import { ingestFolder } from '../lib/ingest.mjs';

/**
 * `includeFailed`: a guide from a FAILING run — the review case. Off by
 * default (a published how-to must come from a passing run), on for a
 * test-review tool that needs the failing attempt's video and steps.
 */
const att = (p) => [{ name: 'video', contentType: 'video/webm', path: p }];
const ann = (ref) => [{ type: 'guide', description: JSON.stringify({ objective: ref.replace('/', '--') + '--default', title: ref, journeyRef: ref, category: 'c' }) }];
const test_ = (title, attempts) => ({ title, file: 'e2e/graphs.spec.ts', tests: [{ annotations: ann(title), results: attempts }] });
const attempt = (status, video, error) => ({ status, duration: 7, startTime: '2026-09-06T00:00:00.000Z', steps: [], attachments: video ? att(video) : [], ...(error ? { error: { message: error } } : {}) });
const report = (specs) => ({ suites: [{ title: 'e2e/graphs.spec.ts', file: 'e2e/graphs.spec.ts', specs }] });

test('build-core: default skips non-passing tests; includeFailed keeps failed + flaky-with-final-fail, never skipped', () => {
  const r = report([
    test_('p/ok', [attempt('passed', '/v/ok.webm')]),
    test_('p/bad', [attempt('failed', '/v/bad.webm', '[31mexpected 1 got 2[0m')]),
    test_('p/retried', [attempt('failed', '/v/r1.webm', 'first'), attempt('failed', '/v/r2.webm', 'second')]),
    test_('p/flaky', [attempt('failed', '/v/f1.webm', 'x'), attempt('passed', '/v/f2.webm')]),
    test_('p/skipped', [attempt('skipped', null)]),
    test_('p/novideo', [attempt('failed', null, 'no video at all')]),
  ]);
  const off = buildFromReport(r);
  assert.deepEqual(off.guides.map((g) => [g.slug, g.outcome]), [['p--ok--default', 'passed'], ['p--flaky--default', 'flaky']]);
  assert.equal(off.guides[1].videoPath, '/v/f2.webm', 'flaky → the PASSING attempt\'s video');

  const on = buildFromReport(r, { includeFailed: true });
  assert.deepEqual(on.guides.map((g) => [g.slug, g.outcome]), [
    ['p--ok--default', 'passed'], ['p--bad--default', 'failed'], ['p--retried--default', 'failed'], ['p--flaky--default', 'flaky'],
  ]);
  const bad = on.guides.find((g) => g.slug === 'p--bad--default');
  assert.equal(bad.error, 'expected 1 got 2', 'ANSI stripped');
  assert.equal(bad.videoPath, '/v/bad.webm');
  assert.equal(on.guides.find((g) => g.slug === 'p--retried--default').videoPath, '/v/r2.webm', 'failed → the LAST attempt');
  assert.equal(on.registry['p--bad--default'].outcome, 'failed');
  assert.equal(on.registry['p--ok--default'].outcome, 'passed');
});

test('ingest --include-failed: the failed test gets a folder, guide.json carries outcome + error, index links it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'js-failed-'));
  try {
    const tr = path.join(dir, 'test-results');
    mkdirSync(tr, { recursive: true });
    const v = path.join(tr, 'v.webm');
    writeFileSync(v, Buffer.alloc(8));
    const r = report([
      test_('p/ok', [attempt('passed', v)]),
      test_('p/bad', [attempt('failed', v, 'Lead was not created')]),
    ]);
    writeFileSync(path.join(tr, 'results.json'), JSON.stringify(r));
    const out = path.join(dir, 'guides');

    const plain = ingestFolder(tr, { out, batchId: 'plain', now: 'n' });
    assert.equal(plain.guideCount, 1);
    assert.equal(existsSync(path.join(out, 'plain', 'p--bad--default')), false);
    assert.equal(plain.tests.find((t) => t.title === 'p/bad').slug, undefined);

    const rev = ingestFolder(tr, { out, batchId: 'rev', now: 'n', includeFailed: true });
    assert.equal(rev.guideCount, 2);
    const guide = JSON.parse(readFileSync(path.join(out, 'rev', 'p--bad--default', 'guide.json'), 'utf8'));
    assert.equal(guide.outcome, 'failed');
    assert.equal(guide.error, 'Lead was not created');
    assert.equal(JSON.parse(readFileSync(path.join(out, 'rev', 'p--ok--default', 'guide.json'), 'utf8')).outcome, 'passed');
    assert.equal(rev.tests.find((t) => t.title === 'p/bad').slug, 'p--bad--default', 'the dashboard card links to the page');
    assert.deepEqual(rev.results, { passed: 1, failed: 1, skipped: 0, flaky: 0, total: 2 });
    assert.equal(rev.guides.find((g) => g.slug === 'p--bad--default').outcome, 'failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
