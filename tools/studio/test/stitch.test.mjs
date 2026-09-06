import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planCut, ffmpegArgs, stitchVideos, isVideoTimeline, probeMs } from '../lib/stitch.mjs';
import { ingestFolder } from '../lib/ingest.mjs';

// ───────────── planCut (pure) ─────────────
const tl = (videos, segments) => ({ schema: 'video-timeline/v1', videos, segments });
const V = (id, persona, startedAt, file = `${id}.webm`) => ({ id, persona, file, startedAt });
const S = (persona, startedAt, endedAt, title = persona) => ({ persona, startedAt, endedAt, title, status: 'ok' });

test('planCut: each step shows the acting persona; the gap before a step belongs to that step\'s persona', () => {
  const plan = planCut(
    tl([V('v1', 'sub', 1000), V('v2', 'app', 1000)], [S('sub', 1500, 2500, 'submit'), S('app', 3500, 5000, 'approve')]),
    { v1: 10_000, v2: 10_000 },
  );
  assert.deepEqual(plan.clips, [
    { videoId: 'v1', persona: 'sub', inMs: 500, durMs: 1000, title: 'submit' },
    { videoId: 'v2', persona: 'app', inMs: 1500, durMs: 2500, title: 'approve' }, // gap 2500–3500 + step 3500–5000, merged
  ]);
  assert.equal(plan.totalMs, 3500);
  assert.deepEqual(plan.skipped, []);
});

test('planCut: a persona whose recording starts mid-gap — previous source holds until it exists', () => {
  const plan = planCut(
    tl([V('v1', 'sub', 1000), V('v2', 'app', 3000)], [S('sub', 1500, 2500, 'submit'), S('app', 3500, 5000, 'approve')]),
    { v1: 10_000, v2: 10_000 },
  );
  assert.deepEqual(plan.clips, [
    { videoId: 'v1', persona: 'sub', inMs: 500, durMs: 1500, title: 'submit' }, // 1500–2500 step, then held to 3000 while the approver has no recording
    { videoId: 'v2', persona: 'app', inMs: 0, durMs: 2000, title: 'approve' },  // 3000–5000: login tail + step, merged
  ]);
});

test('planCut: never reads past a recording\'s real end; the rest falls back, then is reported', () => {
  const plan = planCut(tl([V('v1', 'sub', 0)], [S('sub', 0, 5000, 'long')]), { v1: 2000 });
  assert.deepEqual(plan.clips, [{ videoId: 'v1', persona: 'sub', inMs: 0, durMs: 2000, title: 'long' }]);
  assert.deepEqual(plan.skipped, ['long']);
});

test('planCut: a persona re-login (second recording) is picked once it has started', () => {
  const plan = planCut(
    tl([V('v1', 'sub', 0), V('v2', 'sub', 4000)], [S('sub', 100, 1100, 'a'), S('sub', 4500, 5500, 'b')]),
    { v1: 3000, v2: 3000 },
  );
  assert.deepEqual(plan.clips.map((c) => [c.videoId, c.inMs, c.durMs]), [
    ['v1', 100, 2900],   // step a, then hold on v1 until it ends at 3000
    ['v2', 0, 1500],     // 4000–5500 (gap tail + step b) — 3000–4000 had no footage
  ]);
  assert.deepEqual(plan.skipped, ['b']);
});

test('planCut: leadMs shows the run-up; nothing to cut → empty plan, every segment skipped', () => {
  const lead = planCut(tl([V('v1', 'sub', 0)], [S('sub', 2000, 3000, 'x')]), { v1: 5000 }, { leadMs: 500 });
  assert.deepEqual(lead.clips, [{ videoId: 'v1', persona: 'sub', inMs: 1500, durMs: 1500, title: 'x' }]);
  const none = planCut(tl([], [S('sub', 0, 1, 'x')]), {});
  assert.deepEqual(none, { clips: [], totalMs: 0, skipped: ['x'] });
  assert.equal(planCut(tl([V('v1', 'sub', 0)], []), { v1: 1000 }).clips.length, 0);
});

test('planCut: a first interval with no footage at all is skipped, later ones still cut', () => {
  const plan = planCut(tl([V('v1', 'app', 5000)], [S('sub', 0, 1000, 'orphan'), S('app', 5500, 6000, 'ok')]), { v1: 5000 });
  assert.deepEqual(plan.skipped, ['orphan', 'ok']); // 0–1000 orphan; 1000–5000 gap for app also has nothing yet
  assert.deepEqual(plan.clips, [{ videoId: 'v1', persona: 'app', inMs: 0, durMs: 1000, title: 'ok' }]); // 5000–6000: the moment footage exists
});

test('isVideoTimeline + ffmpegArgs shape', () => {
  assert.equal(isVideoTimeline(tl([], [])), true);
  assert.equal(isVideoTimeline({ schema: 'nope' }), false);
  const plan = planCut(tl([V('v1', 'sub', 0)], [S('sub', 0, 1000, 'x')]), { v1: 2000 });
  const args = ffmpegArgs(plan, { v1: '/a/v1.webm' }, '/o/raw.webm', { label: false });
  assert.equal(args[0], '-y');
  assert.deepEqual(args.slice(1, 3), ['-i', '/a/v1.webm']);
  const fc = args[args.indexOf('-filter_complex') + 1];
  assert.match(fc, /\[0:v\]trim=start=0\.000:end=1\.000,setpts=PTS-STARTPTS/);
  assert.match(fc, /concat=n=1:v=1:a=0\[v\]/);
  assert.equal(args[args.length - 1], '/o/raw.webm');
});

// ───────────── real ffmpeg: colours prove the cut ─────────────
const hasFfmpeg = (() => { try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

/** A solid-colour vp8 clip. Colours are chosen so a wrong source is unmistakable. */
function colourClip(file, colour, seconds) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${colour}:s=160x120:r=25:d=${seconds}`, '-c:v', 'libvpx', '-b:v', '200k', file], { stdio: 'ignore' });
}
/** Average colour at second t of a video, as [r,g,b] (whole-frame average — a wrong source is unmistakable). */
function pixelAt(file, t) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', 'scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [raw[0], raw[1], raw[2]];
}
const isRed = ([r, g, b]) => r > 180 && g < 80 && b < 80;
const isBlue = ([r, g, b]) => b > 180 && r < 80 && g < 80;

test('stitchVideos: the output shows the acting persona\'s screen at every second', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stitch-'));
  try {
    const red = path.join(dir, 'sub.webm');   // submitter's screen, started at t=1000
    const blue = path.join(dir, 'app.webm');  // approver's screen, started at t=3000
    colourClip(red, 'red', 6);
    colourClip(blue, 'blue', 6);
    const timeline = tl(
      [V('v1', 'submitter', 1000, 'sub.webm'), V('v2', 'approver', 3000, 'app.webm')],
      [S('submitter', 1500, 2500, 'expense.submit'), S('approver', 3500, 5000, 'expense.approve'), S('submitter', 5200, 6000, 'expense.check')],
    );
    const out = path.join(dir, 'raw.webm');
    const plan = stitchVideos(timeline, { v1: red, v2: blue }, out, { width: 160, height: 120, label: false });
    assert.ok(plan, 'a plan was produced');
    assert.deepEqual(plan.clips.map((c) => [c.persona, c.inMs, c.durMs]), [
      ['submitter', 500, 1500],   // wall 1500–3000: submit, then hold — the approver is not recording yet
      ['approver', 0, 2000],      // wall 3000–5000: approver's login tail + approve
      ['submitter', 4000, 1000],  // wall 5000–6000: gap + expense.check
    ]);
    assert.equal(plan.totalMs, 4500);
    const dur = probeMs(out);
    assert.ok(Math.abs(dur - 4500) <= 120, `duration ${dur}ms ≈ 4500ms`);
    // composite t → wall-clock 1500+t
    assert.ok(isRed(pixelAt(out, 0.5)), 't=0.5s (wall 2000) submitter acting → red');
    assert.ok(isRed(pixelAt(out, 1.3)), 't=1.3s (wall 2800) waiting for approver, no footage yet → still red');
    assert.ok(isBlue(pixelAt(out, 1.7)), 't=1.7s (wall 3200) approver logging in → blue');
    assert.ok(isBlue(pixelAt(out, 3.0)), 't=3.0s (wall 4500) approver acting → blue');
    assert.ok(isRed(pixelAt(out, 4.2)), 't=4.2s (wall 5700) submitter checks → red');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestFolder: a multi-persona test gets ONE stitched raw.webm and records the cut in guide.json', { skip: !hasFfmpeg && 'ffmpeg not installed' }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stitch-ingest-'));
  try {
    const tr = path.join(dir, 'test-results', 'e2e-graphs-x');
    mkdirSync(path.join(tr, 'videos', 'sub'), { recursive: true });
    mkdirSync(path.join(tr, 'videos', 'app'), { recursive: true });
    const red = path.join(tr, 'videos', 'sub', 'aaaa.webm');
    const blue = path.join(tr, 'videos', 'app', 'bbbb.webm');
    colourClip(red, 'red', 4);
    colourClip(blue, 'blue', 4);
    const timeline = tl(
      [V('v1', 'sub', 0, 'aaaa.webm'), V('v2', 'app', 0, 'bbbb.webm')],
      [S('sub', 0, 1000, 'submit'), S('app', 1000, 3000, 'approve')],
    );
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
    const report = { suites: [{ title: 'e2e/graphs.spec.ts', file: 'e2e/graphs.spec.ts', specs: [{ title: 'crm/x', file: 'e2e/graphs.spec.ts', tests: [{
      annotations: [{ type: 'guide', description: JSON.stringify({ objective: 'crm--x--default', title: 'X', category: 'crm', journeyRef: 'crm/x' }) }],
      results: [{ status: 'passed', duration: 3000, startTime: '2026-09-06T00:00:00.000Z', steps: [], attachments: [
        { name: 'video', contentType: 'video/webm', path: red },
        { name: 'video', contentType: 'video/webm', path: blue },
        { name: 'videos', contentType: 'application/json', body: b64([{ persona: 'sub', file: 'aaaa.webm' }, { persona: 'app', file: 'bbbb.webm' }]) },
        { name: 'video-timeline', contentType: 'application/json', body: b64(timeline) },
      ] }],
    }] }] }] };
    writeFileSync(path.join(dir, 'test-results', 'results.json'), JSON.stringify(report));
    const out = path.join(dir, 'guides');
    const entry = ingestFolder(path.join(dir, 'test-results'), { out, batchId: 'b1', now: '2026-09-06T00:00:00.000Z' });
    assert.equal(entry.guideCount, 1);
    const raw = path.join(out, 'b1', 'crm--x--default', 'raw.webm');
    assert.ok(existsSync(raw));
    assert.ok(Math.abs(probeMs(raw) - 3000) <= 120, 'cut is the 3s of acting, not 4s of either source');
    assert.ok(isRed(pixelAt(raw, 0.5)));
    assert.ok(isBlue(pixelAt(raw, 2.0)));
    const guide = JSON.parse(require_(path.join(out, 'b1', 'crm--x--default', 'guide.json')));
    assert.equal(guide.stitched.recordings.length, 2);
    assert.deepEqual(guide.stitched.clips.map((c) => c.persona), ['sub', 'app']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ingestFolder: a single-video test is copied, not stitched (no `stitched` in guide.json)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'stitch-single-'));
  try {
    const tr = path.join(dir, 'test-results', 'e2e-one');
    mkdirSync(tr, { recursive: true });
    const vid = path.join(tr, 'video.webm');
    writeFileSync(vid, Buffer.alloc(32));
    const report = { suites: [{ title: 's', file: 'e2e/one.spec.ts', specs: [{ title: 'one', file: 'e2e/one.spec.ts', tests: [{ annotations: [], results: [{ status: 'passed', duration: 1, startTime: '2026-09-06T00:00:00.000Z', steps: [], attachments: [{ name: 'video', contentType: 'video/webm', path: vid }] }] }] }] }] };
    writeFileSync(path.join(dir, 'test-results', 'results.json'), JSON.stringify(report));
    const out = path.join(dir, 'guides');
    ingestFolder(path.join(dir, 'test-results'), { out, batchId: 'b2', now: '2026-09-06T00:00:00.000Z' });
    const guide = JSON.parse(require_(path.join(out, 'b2', 'one', 'guide.json')));
    assert.equal('stitched' in guide, false);
    assert.ok(existsSync(path.join(out, 'b2', 'one', 'raw.webm')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function require_(p) { return execFileSync('cat', [p]).toString(); }
