import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildVideoTimeline, collectVideos, videoMode, videoPolicy, videoSize } from '../../src/studio/video';

/**
 * The pure half of per-persona video (src/studio/video.ts). The policy must
 * match Playwright's own record/keep rules for the `video` option so a Cast
 * run behaves exactly like a `page`-fixture run would under the same config.
 */
test.describe('videoPolicy mirrors Playwright', () => {
  test('on: record and keep regardless of outcome', () => {
    const p = videoPolicy('on', 0);
    expect(p.record).toBe(true);
    expect(p.keep('passed', 'passed')).toBe(true);
    expect(p.keep('failed', 'passed')).toBe(true);
  });

  test('retain-on-failure: record, keep only when status ≠ expected', () => {
    const p = videoPolicy('retain-on-failure', 0);
    expect(p.record).toBe(true);
    expect(p.keep('passed', 'passed')).toBe(false);
    expect(p.keep('failed', 'passed')).toBe(true);
    expect(p.keep('timedOut', 'passed')).toBe(true);
    // an expected failure (test.fail) that failed is NOT kept
    expect(p.keep('failed', 'failed')).toBe(false);
  });

  test('on-first-retry: only on retry 1', () => {
    expect(videoPolicy('on-first-retry', 0).record).toBe(false);
    expect(videoPolicy('on-first-retry', 1).record).toBe(true);
    expect(videoPolicy('on-first-retry', 1).keep('passed', 'passed')).toBe(true);
    expect(videoPolicy('on-first-retry', 2).record).toBe(false);
  });

  test('off / undefined: nothing', () => {
    expect(videoPolicy('off', 0).record).toBe(false);
    expect(videoPolicy(undefined, 0).record).toBe(false);
    expect(videoPolicy(undefined, 0).keep('failed', 'passed')).toBe(false);
  });

  test('object form carries mode and size', () => {
    const v = { mode: 'on' as const, size: { width: 1280, height: 720 } };
    expect(videoMode(v)).toBe('on');
    expect(videoSize(v)).toEqual({ width: 1280, height: 720 });
    expect(videoSize('on')).toBeUndefined();
    expect(videoPolicy(v, 0).record).toBe(true);
  });
});

test.describe('buildVideoTimeline — the stitching contract', () => {
  const step = (personaId: string, startedAt: number, ms: number, name: string, status = 'ok') => ({
    personaId, startedAt, ms, name, status,
  });

  test('videos in start order with ids, segments in journey order with endedAt', () => {
    const tl = buildVideoTimeline(
      [
        { persona: 'approver', path: '/r/videos/approver/b.webm', startedAt: 2000 },
        { persona: 'submitter', path: '/r/videos/submitter/a.webm', startedAt: 1000 },
      ],
      [step('submitter', 1100, 500, 'expense.submit'), step('approver', 2200, 300, 'expense.approve')],
    );
    expect(tl).toEqual({
      schema: 'video-timeline/v1',
      videos: [
        { id: 'v1', persona: 'submitter', file: 'a.webm', startedAt: 1000 },
        { id: 'v2', persona: 'approver', file: 'b.webm', startedAt: 2000 },
      ],
      segments: [
        { persona: 'submitter', startedAt: 1100, endedAt: 1600, title: 'expense.submit', status: 'ok' },
        { persona: 'approver', startedAt: 2200, endedAt: 2500, title: 'expense.approve', status: 'ok' },
      ],
    });
  });

  test('a video or step with no startedAt cannot be aligned and is left out; a negative ms is clamped', () => {
    const tl = buildVideoTimeline(
      [{ persona: 'ghost', path: '/x/g.webm' }, { persona: 'sub', path: '/x/s.webm', startedAt: 5 }],
      [step('sub', 10, -50, 'oops', 'failed'), { personaId: 'sub', ms: 5, name: 'untimed', status: 'ok' }],
    );
    expect(tl.videos.map((v) => v.id + ':' + v.persona)).toEqual(['v1:sub']);
    expect(tl.segments).toEqual([{ persona: 'sub', startedAt: 10, endedAt: 10, title: 'oops', status: 'failed' }]);
  });

  test('same start time orders by persona name so the output is deterministic', () => {
    const tl = buildVideoTimeline(
      [{ persona: 'b', path: '/b.webm', startedAt: 1 }, { persona: 'a', path: '/a.webm', startedAt: 1 }],
      [],
    );
    expect(tl.videos.map((v) => v.persona)).toEqual(['a', 'b']);
    expect(tl.segments).toEqual([]);
  });
});

test.describe('collectVideos', () => {
  let dir: string;
  test.beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-videos-'));
  });
  test.afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const touch = (...p: string[]) => {
    const f = path.join(dir, ...p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
  };

  test('primary actor first, then the rest in session order, unknowns alphabetically after', () => {
    touch('approver', 'b.webm');
    touch('submitter', 'a.webm');
    touch('zeta', 'z.webm');
    touch('auditor', 'c.webm');
    const got = collectVideos(dir, ['submitter', 'approver']);
    expect(got.map((v) => v.persona)).toEqual(['submitter', 'approver', 'auditor', 'zeta']);
    expect(got[0]!.path).toBe(path.join(dir, 'submitter', 'a.webm'));
  });

  test('a persona with two pages yields two files, sorted; non-webm ignored', () => {
    touch('sub', '2.webm');
    touch('sub', '1.webm');
    touch('sub', 'notes.txt');
    expect(collectVideos(dir, ['sub']).map((v) => path.basename(v.path))).toEqual(['1.webm', '2.webm']);
  });

  test('missing dir → [] (video off, or the walk died before any session)', () => {
    expect(collectVideos(path.join(dir, 'nope'))).toEqual([]);
  });

  test('empty persona dir contributes nothing', () => {
    fs.mkdirSync(path.join(dir, 'ghost'));
    expect(collectVideos(dir)).toEqual([]);
  });
});
