/**
 * R1 — recording session plumbing (pure, unit-testable).
 * The record spec (tests/record/record.spec.ts) wires these to a headed
 * Cast-authenticated context with tracing + HAR. Recording artifacts land in
 * recordings/<journey>/<persona>-<timestamp>/ and are consumed by the R2
 * trace reader; recordings/ is scratch material and stays gitignored.
 */

import * as path from 'path';

export interface RecordEnv {
  journey: string;
  persona: string;
  expectDenial: boolean;
}

const ID_RE = /^[a-z][a-z0-9_]*$/;

/** Parse + validate RECORD_* env config; every problem reported at once. */
export function parseRecordEnv(
  env: NodeJS.ProcessEnv,
  knownPersonas: string[],
): { ok: true; value: RecordEnv } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const journey = env.RECORD_JOURNEY?.trim() ?? '';
  const persona = env.RECORD_PERSONA?.trim() ?? '';

  if (!journey) errors.push('RECORD_JOURNEY is required (lower_snake_case journey id)');
  else if (!ID_RE.test(journey)) errors.push(`RECORD_JOURNEY '${journey}' must be lower_snake_case`);

  if (!persona) errors.push('RECORD_PERSONA is required');
  else if (!knownPersonas.includes(persona)) {
    errors.push(`RECORD_PERSONA '${persona}' unknown — personas.json has: ${knownPersonas.join(', ')}`);
  }

  const rawDenial = env.RECORD_EXPECT_DENIAL?.trim().toLowerCase();
  if (rawDenial !== undefined && !['', '0', '1', 'true', 'false'].includes(rawDenial)) {
    errors.push(`RECORD_EXPECT_DENIAL '${rawDenial}' must be 1/0/true/false`);
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { journey, persona, expectDenial: rawDenial === '1' || rawDenial === 'true' },
  };
}

/** recordings/<journey>/<persona>-<YYYYMMDD-HHMMSS>/ */
export function recordingDirFor(
  journey: string,
  persona: string,
  when: Date,
  root = 'recordings',
): string {
  const ts = when
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/T/, '-')
    .slice(0, 15); // 20260830-141530
  return path.join(root, journey, `${persona}-${ts}`);
}

export interface RecordingManifest {
  schema: 'sf-recording/1';
  journey: string;
  persona: string;
  expectDenial: boolean;
  startedAt: string;
  endedAt: string;
  playwrightVersion: string;
  files: { trace: string; har: string };
}

export function buildManifest(opts: {
  env: RecordEnv;
  startedAt: Date;
  endedAt: Date;
  playwrightVersion: string;
}): RecordingManifest {
  return {
    schema: 'sf-recording/1',
    journey: opts.env.journey,
    persona: opts.env.persona,
    expectDenial: opts.env.expectDenial,
    startedAt: opts.startedAt.toISOString(),
    endedAt: opts.endedAt.toISOString(),
    playwrightVersion: opts.playwrightVersion,
    files: { trace: 'trace.zip', har: 'network.har' },
  };
}

/** HAR scope: the network families the distiller cares about (founding doc §3.4). */
export const HAR_URL_FILTER = /\/(aura|sfsites\/aura|services\/data)\b|\/lightning\//;
