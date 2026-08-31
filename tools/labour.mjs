#!/usr/bin/env node
/**
 * S4 — npm run labour: print the scaffold→green wall clock per journey/graph
 * from journeys/telemetry.jsonl. Pure reader; mirrors src/telemetry.ts math
 * (kept dependency-free so it runs without a TS toolchain).
 */
import * as fs from 'fs';
import * as path from 'path';

const file = process.env.TELEMETRY_FILE || path.resolve('journeys', 'telemetry.jsonl');
if (!fs.existsSync(file)) {
  console.log('no telemetry yet — capture, pipeline, and run events will land in journeys/telemetry.jsonl');
  process.exit(0);
}

const byId = new Map();
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  let e;
  try { e = JSON.parse(line); } catch { continue; }
  if (!e.id || !e.kind || !e.at) continue;
  let s = byId.get(e.id);
  if (!s) { s = { id: e.id, captures: 0, pipelines: 0, runs: 0, greens: 0 }; byId.set(e.id, s); }
  if (e.kind === 'capture') { s.captures += 1; s.firstCaptureAt ??= e.at; }
  else if (e.kind === 'pipeline') s.pipelines += 1;
  else if (e.kind === 'run') { s.runs += 1; if (e.ok) { s.greens += 1; s.firstGreenAt ??= e.at; } }
}

const human = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}min` : `${(ms / 3_600_000).toFixed(1)}h`);

console.log('labour telemetry (scaffold → first green, wall clock):');
for (const s of [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))) {
  let span = '—';
  if (s.firstCaptureAt && s.firstGreenAt) {
    const ms = Date.parse(s.firstGreenAt) - Date.parse(s.firstCaptureAt);
    if (ms >= 0) span = human(ms);
  } else if (s.firstCaptureAt) span = 'not green yet';
  console.log(`  ${s.id}: ${span} · captures ${s.captures} · pipelines ${s.pipelines} · runs ${s.runs} (${s.greens} green)`);
}
