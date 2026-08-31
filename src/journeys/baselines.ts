/**
 * baselines.json lifecycle (sprint S-REC R0; design doc §7.1).
 *
 * The runner READS baselines (p95 grading, soft ×1.5 / hard ×3). This module
 * owns the WRITE side: a rolling sample window per step key
 * ("idx:actorAlias/stepName"), derived mean/p95, updated ONLY from fully-green
 * journey reports (the runner throws on hard failures, so a report you hold IS
 * green; soft-flagged steps still update — drift stays visible as a trend, not
 * a surprise).
 *
 * Storage decision (substrate: cdp_telemetry__storage_split__*): baselines are
 * REPO FILES, never atoms — they change every green run.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Baselines, StepBaseline, JourneyReport } from './runner';
import { baselineKey } from './runner';

/** Persisted shape: published fields + the sample window that derives them. */
export interface StoredStepBaseline extends StepBaseline {
  /** Rolling window of the most recent green durations (newest last). */
  samples: number[];
}

export interface StoredBaselines extends Baselines {
  steps: Record<string, StoredStepBaseline>;
  /** Max samples retained per step (default 20). */
  windowSize?: number;
}

export const DEFAULT_WINDOW_SIZE = 20;

export interface UpdateOptions {
  /** Drop step keys absent from the report (journey edited/reordered). Default true. */
  prune?: boolean;
  windowSize?: number;
  /** Injectable date for deterministic tests. */
  today?: string;
}

/** p95 of a sample set: value at ceil(0.95 · n), 1-based (nearest-rank). */
export function p95(samples: number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0;
}

export function mean(samples: number[]): number {
  if (samples.length === 0) return 0;
  return Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
}

/** Start an empty baselines doc for a journey. */
export function emptyBaselines(journey: string, windowSize = DEFAULT_WINDOW_SIZE): StoredBaselines {
  return { journey, steps: {}, windowSize };
}

/**
 * Fold one green report into the baselines (pure — returns a new doc).
 * Only 'do' steps carry timing knowledge; deny steps are probes, not journeys'
 * performance surface, and the runner does not grade them.
 */
export function updateBaselines(
  baselines: StoredBaselines,
  report: JourneyReport,
  opts: UpdateOptions = {},
): StoredBaselines {
  if (baselines.journey !== report.journey) {
    throw new Error(
      `baselines are for journey '${baselines.journey}' but the report is '${report.journey}' — one baselines file per journey`,
    );
  }
  const windowSize = opts.windowSize ?? baselines.windowSize ?? DEFAULT_WINDOW_SIZE;
  const prune = opts.prune ?? true;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);

  const next: StoredBaselines = {
    journey: baselines.journey,
    windowSize,
    ...(baselines.budgets ? { budgets: baselines.budgets } : {}),
    steps: {},
  };

  const seen = new Set<string>();
  for (const step of report.steps) {
    if (step.kind !== 'do') continue;
    const key = baselineKey(step.index, step.actorAlias, step.name);
    seen.add(key);
    const prev = baselines.steps[key];
    const samples = [...(prev?.samples ?? []), step.ms].slice(-windowSize);
    next.steps[key] = {
      n: (prev?.n ?? 0) + 1,
      samples,
      meanMs: mean(samples),
      p95Ms: p95(samples),
      updated: today,
    };
  }

  if (!prune) {
    for (const [key, prev] of Object.entries(baselines.steps)) {
      if (!seen.has(key)) next.steps[key] = prev;
    }
  }

  return next;
}

/** Load a baselines file; absent file → empty doc for the journey. */
export function loadBaselinesFile(file: string, journey: string): StoredBaselines {
  if (!fs.existsSync(file)) return emptyBaselines(journey);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as StoredBaselines;
  if (doc.journey !== journey) {
    throw new Error(`baselines file ${file} is for '${doc.journey}', expected '${journey}'`);
  }
  return doc;
}

/** Save with stable key order so diffs review cleanly. */
export function saveBaselinesFile(file: string, baselines: StoredBaselines): void {
  const ordered: StoredBaselines = {
    journey: baselines.journey,
    windowSize: baselines.windowSize ?? DEFAULT_WINDOW_SIZE,
    ...(baselines.budgets ? { budgets: baselines.budgets } : {}),
    steps: Object.fromEntries(
      Object.entries(baselines.steps).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })),
    ),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
}

/** Conventional location: journeys/baselines/<journey>.baselines.json */
export function baselinesPathFor(journey: string, dir = path.join('journeys', 'baselines')): string {
  return path.join(dir, `${journey}.baselines.json`);
}
