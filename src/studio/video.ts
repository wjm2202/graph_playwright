/**
 * Per-persona video for Cast sessions.
 *
 * Playwright only records video for contexts made by ITS OWN `context`
 * fixture (playwright/lib/index.js `_contextFactory` injects `recordVideo`);
 * a context from `browser.newContext()` gets viewport/locale/storageState
 * merged in but never `recordVideo`. Cast opens every persona session that
 * way, so `use: { video: 'on' }` alone records nothing for a graph walk.
 *
 * Cast therefore records itself: one `recordVideo.dir` per persona under
 * the test's output folder, and the fixture attaches every .webm as `video`
 * after teardown — the same attachment name Playwright uses, so Journey
 * Studio (which takes the first `video` attachment) and the HTML report both
 * see them. This module is the PURE half: the policy and the file walk.
 * The Playwright-facing half lives in src/fixtures/cast.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

/** Playwright's `video` option, as the fixture receives it. */
export type VideoOption =
  | 'off'
  | 'on'
  | 'retain-on-failure'
  | 'on-first-retry'
  | { mode: 'off' | 'on' | 'retain-on-failure' | 'on-first-retry'; size?: { width: number; height: number } };

export type VideoMode = 'off' | 'on' | 'retain-on-failure' | 'on-first-retry';

export function videoMode(video: VideoOption | undefined): VideoMode {
  if (!video) return 'off';
  return typeof video === 'string' ? video : video.mode;
}

export function videoSize(video: VideoOption | undefined): { width: number; height: number } | undefined {
  return typeof video === 'object' ? video.size : undefined;
}

/**
 * Mirror of Playwright's shouldCaptureVideo / shouldPreserveVideo:
 *   on                → record, keep
 *   retain-on-failure → record, keep only when status ≠ expectedStatus
 *   on-first-retry    → record on retry 1 only, keep
 *   off               → nothing
 */
export function videoPolicy(video: VideoOption | undefined, retry: number): {
  record: boolean;
  keep: (status: string | undefined, expectedStatus: string) => boolean;
} {
  const mode = videoMode(video);
  switch (mode) {
    case 'on':
      return { record: true, keep: () => true };
    case 'retain-on-failure':
      return { record: true, keep: (status, expected) => status !== expected };
    case 'on-first-retry':
      return { record: retry === 1, keep: () => retry === 1 };
    default:
      return { record: false, keep: () => false };
  }
}

export interface PersonaVideo {
  persona: string;
  /** Absolute path to the .webm. */
  path: string;
  /** Epoch ms when the page (and so its recording) opened. Absent when the
   *  file was found on disk without a matching page registration. */
  startedAt?: number;
}

/** One acting interval of the run — a StepReport reduced to what a cut needs. */
export interface ActingSegment {
  persona: string;
  startedAt: number;
  endedAt: number;
  title: string;
  status: string;
}

/**
 * The stitching contract handed to Journey Studio as the `video-timeline`
 * attachment. Every persona's screen is recorded in parallel (one file per
 * page, wall-clock frames); `segments` say who was ACTING when, so a single
 * linear video can be cut that shows the acting persona's screen for each
 * step, in journey order. Times are epoch ms on the same clock as `videos`.
 */
export interface VideoTimeline {
  schema: 'video-timeline/v1';
  videos: { id: string; persona: string; file: string; startedAt: number }[];
  segments: ActingSegment[];
}

/**
 * PURE. Videos or steps without a startedAt cannot be aligned and are
 * dropped; ids are `v1, v2, …` in start order. Segments keep journey order
 * and are clamped so endedAt ≥ startedAt. `file` is the basename — Journey Studio resolves it
 * next to the `video` attachments it copied.
 */
export function buildVideoTimeline(
  videos: PersonaVideo[],
  steps: { personaId: string; startedAt?: number; ms: number; name: string; status: string }[],
): VideoTimeline {
  const aligned = videos
    .filter((v): v is PersonaVideo & { startedAt: number } => typeof v.startedAt === 'number')
    .sort((a, b) => a.startedAt - b.startedAt || a.persona.localeCompare(b.persona));
  return {
    schema: 'video-timeline/v1',
    videos: aligned.map((v, i) => ({
      id: `v${i + 1}`,
      persona: v.persona,
      file: path.basename(v.path),
      startedAt: v.startedAt,
    })),
    segments: steps
      .filter((s): s is typeof s & { startedAt: number } => typeof s.startedAt === 'number')
      .map((s) => ({
        persona: s.personaId,
        startedAt: s.startedAt,
        endedAt: s.startedAt + Math.max(0, s.ms),
        title: s.name,
        status: s.status,
      })),
  };
}

/**
 * Every .webm under `<dir>/<persona>/`, personas in the order given (first
 * session opened first — Journey Studio's "primary" video), unknown persona
 * folders after that alphabetically, files within a persona alphabetically
 * (a popup page gets its own file). Missing dir → [].
 */
export function collectVideos(dir: string, order: string[] = []): PersonaVideo[] {
  let personas: string[];
  try {
    personas = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const rank = new Map(order.map((p, i) => [p, i]));
  personas.sort((a, b) => {
    const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
    const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
    return ra !== rb ? ra - rb : a.localeCompare(b);
  });
  const out: PersonaVideo[] = [];
  for (const persona of personas) {
    const pdir = path.join(dir, persona);
    const files = fs
      .readdirSync(pdir)
      .filter((f) => f.endsWith('.webm'))
      .sort();
    for (const f of files) out.push({ persona, path: path.join(pdir, f) });
  }
  return out;
}
