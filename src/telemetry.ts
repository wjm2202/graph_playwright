/**
 * S4 — labour telemetry: the 50%-less-labour target measured, not asserted.
 *
 * One append-only JSONL (journeys/telemetry.jsonl, override TELEMETRY_FILE).
 * Events mark the scaffold→green wall clock per journey/graph id:
 *   capture   a human drove a recording session
 *   pipeline  distill+generate produced artifacts
 *   run       runGraphFile executed (ok = every step & oracle held)
 * Recording is BEST-EFFORT — telemetry must never fail a run — and summarize
 * is pure so the math is unit-testable.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface TelemetryEvent {
  kind: 'capture' | 'pipeline' | 'run';
  /** journey or graph id the event belongs to. */
  id: string;
  ok?: boolean;
  ms?: number;
}

export function telemetryFile(): string {
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' means unset for env vars
  return process.env.TELEMETRY_FILE || path.resolve('journeys', 'telemetry.jsonl');
}

/** Append one event. Never throws — a broken disk must not fail a test run. */
export function recordEvent(evt: TelemetryEvent, file = telemetryFile()): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...evt }) + '\n');
  } catch {
    /* telemetry is an observer, never an actor */
  }
}

export interface LabourSummary {
  id: string;
  captures: number;
  pipelines: number;
  runs: number;
  greens: number;
  firstCaptureAt?: string;
  firstGreenAt?: string;
  /** Wall clock from first capture to first fully-green run. */
  scaffoldToGreenMs?: number;
}

export function summarize(file = telemetryFile()): LabourSummary[] {
  if (!fs.existsSync(file)) return [];
  const byId = new Map<string, LabourSummary>();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e: { at?: string; kind?: string; id?: string; ok?: boolean };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // a torn write must not poison the report
    }
    if (!e.id || !e.kind || !e.at) continue;
    let s = byId.get(e.id);
    if (!s) {
      s = { id: e.id, captures: 0, pipelines: 0, runs: 0, greens: 0 };
      byId.set(e.id, s);
    }
    if (e.kind === 'capture') {
      s.captures += 1;
      s.firstCaptureAt ??= e.at;
    } else if (e.kind === 'pipeline') {
      s.pipelines += 1;
    } else if (e.kind === 'run') {
      s.runs += 1;
      if (e.ok) {
        s.greens += 1;
        s.firstGreenAt ??= e.at;
      }
    }
  }
  for (const s of byId.values()) {
    if (s.firstCaptureAt && s.firstGreenAt) {
      const ms = Date.parse(s.firstGreenAt) - Date.parse(s.firstCaptureAt);
      if (ms >= 0) s.scaffoldToGreenMs = ms;
    }
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function formatSummary(rows: LabourSummary[]): string {
  if (!rows.length) return 'no telemetry yet — capture, pipeline, and run events will land in journeys/telemetry.jsonl';
  const lines = ['labour telemetry (scaffold → first green, wall clock):'];
  for (const s of rows) {
    const span = s.scaffoldToGreenMs !== undefined ? human(s.scaffoldToGreenMs) : s.firstCaptureAt ? 'not green yet' : '—';
    lines.push(
      `  ${s.id}: ${span} · captures ${s.captures} · pipelines ${s.pipelines} · runs ${s.runs} (${s.greens} green)`,
    );
  }
  return lines.join('\n');
}

function human(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}min`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}
