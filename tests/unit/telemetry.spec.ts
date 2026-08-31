/**
 * S4 — labour telemetry: append-only events, pure summary math, and the
 * runGraphFile hook. Telemetry observes; it must never fail a run.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recordEvent, summarize, formatSummary } from '../../src/telemetry';

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tel-')), 'telemetry.jsonl');

test('events append; summary computes scaffold→first-green per id', () => {
  const file = tmpFile();
  recordEvent({ kind: 'capture', id: 'lead_flow', ms: 240_000 }, file);
  recordEvent({ kind: 'pipeline', id: 'lead_flow' }, file);
  recordEvent({ kind: 'run', id: 'lead_flow', ok: false, ms: 30_000 }, file);
  recordEvent({ kind: 'run', id: 'lead_flow', ok: true, ms: 28_000 }, file);
  recordEvent({ kind: 'run', id: 'lead_flow', ok: true, ms: 27_000 }, file); // later green ignored for "first"
  recordEvent({ kind: 'capture', id: 'other_flow' }, file);

  const rows = summarize(file);
  const lead = rows.find((r) => r.id === 'lead_flow')!;
  expect(lead).toMatchObject({ captures: 1, pipelines: 1, runs: 3, greens: 2 });
  expect(lead.firstCaptureAt).toBeDefined();
  expect(lead.firstGreenAt).toBeDefined();
  expect(lead.scaffoldToGreenMs).toBeGreaterThanOrEqual(0);

  const other = rows.find((r) => r.id === 'other_flow')!;
  expect(other.scaffoldToGreenMs).toBeUndefined();

  const text = formatSummary(rows);
  expect(text).toContain('lead_flow');
  expect(text).toContain('runs 3 (2 green)');
  expect(text).toContain('other_flow: not green yet');
});

test('torn lines and junk are skipped, never poisoning the report', () => {
  const file = tmpFile();
  recordEvent({ kind: 'capture', id: 'x' }, file);
  fs.appendFileSync(file, '{"broken json\nnot json at all\n{"at":"t","kind":"run"}\n');
  recordEvent({ kind: 'run', id: 'x', ok: true }, file);
  const rows = summarize(file);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: 'x', captures: 1, runs: 1, greens: 1 });
});

test('recordEvent never throws — an unwritable path is swallowed', () => {
  // Parent "directory" is a FILE → ENOTDIR, immediately. (Never probe /proc
  // here: under the sandbox's bwrap it can block instead of erroring.)
  const blocker = tmpFile();
  fs.writeFileSync(blocker, 'i am a file, not a directory');
  expect(() => { recordEvent({ kind: 'run', id: 'x' }, path.join(blocker, 'telemetry.jsonl')); }).not.toThrow();
});

test('missing file summarizes to empty, with a friendly format', () => {
  const rows = summarize(path.join(os.tmpdir(), 'never-written-telemetry.jsonl'));
  expect(rows).toEqual([]);
  expect(formatSummary(rows)).toContain('no telemetry yet');
});
