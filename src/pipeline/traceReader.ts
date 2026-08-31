/**
 * R2 — trace reader: Playwright trace.zip → neutral RawEvent[] for the
 * distiller. VERSION-PINNED: the trace format is Playwright-internal, so this
 * reader refuses formats it has not been tested against (regenerate the
 * committed fixture + re-run the suite on every Playwright upgrade:
 * GEN_FIXTURE=1 npx playwright test tests/record/make-fixture-trace.spec.ts --project=record).
 *
 * Verified against trace format version 8 (Playwright 1.62.x):
 *  - trace.trace   NDJSON: {type:'context-options', version, wallTime, monotonicTime}
 *                  then {type:'before'|'after', callId, class, method, params, ...}
 *  - trace.network NDJSON: {type:'resource-snapshot', snapshot: HAR-entry}
 * Extraction uses the system `unzip` binary (present on macOS/Linux/CI) —
 * zero added npm dependencies.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compact } from '../utils/compact';
import { asText } from '../utils/text';

export const SUPPORTED_TRACE_VERSIONS = [8];

/** The network families the pipeline cares about (founding doc §3.4). */
export const NETWORK_SCOPE = /\/(aura|sfsites\/aura|services\/data)\b|\/lightning\//;

export type RawEvent =
  | { kind: 'action'; api: string; selector?: string; value?: string; error?: string; startMs: number; endMs: number }
  | { kind: 'nav'; url: string; error?: string; startMs: number; endMs: number }
  | { kind: 'network'; url: string; method: string; status?: number; startMs: number; endMs: number };

export interface TraceData {
  traceVersion: number;
  playwrightVersion?: string;
  /** Wall-clock anchor pair — lets multi-recording stitching (R6) convert the
   *  per-process monotonic times to absolute wall time. */
  wallTimeMs?: number;
  monotonicMs?: number;
  events: RawEvent[];
}

/** Frame methods that represent human-meaningful actions. */
const ACTION_METHODS = new Set([
  'click', 'dblclick', 'fill', 'press', 'type', 'check', 'uncheck',
  'selectOption', 'setInputFiles', 'hover',
]);

export function readTrace(traceZipPath: string): TraceData {
  if (!fs.existsSync(traceZipPath)) throw new Error(`trace not found: ${traceZipPath}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-read-'));
  try {
    try {
      execFileSync('unzip', ['-o', '-q', traceZipPath, '-d', dir]);
    } catch (e) {
      throw new Error(
        `could not extract ${traceZipPath} — the reader shells out to \`unzip\` (preinstalled on macOS/Linux/CI). ${(e as Error).message}`,
      );
    }
    const traceFile = findOne(dir, /\.trace$/);
    const networkFile = findOne(dir, /\.network$/, true);
    return parseTraceFiles(
      fs.readFileSync(traceFile, 'utf8'),
      networkFile ? fs.readFileSync(networkFile, 'utf8') : '',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Pure core (also used by tests to feed tampered inputs). */
export function parseTraceFiles(traceNdjson: string, networkNdjson: string): TraceData {
  const lines = ndjson(traceNdjson);
  const ctx = lines.find((l) => l.type === 'context-options') as
    | { version?: number; playwrightVersion?: string; wallTime?: number; monotonicTime?: number }
    | undefined;
  if (!ctx || typeof ctx.version !== 'number') {
    throw new Error('trace has no context-options header — not a Playwright trace or truncated');
  }
  if (!SUPPORTED_TRACE_VERSIONS.includes(ctx.version)) {
    throw new Error(
      `unsupported trace format version ${ctx.version} (playwright ${ctx.playwrightVersion ?? '?'}). ` +
        `Reader is pinned to version(s) ${SUPPORTED_TRACE_VERSIONS.join(', ')} — regenerate the fixture ` +
        `(GEN_FIXTURE=1) and extend the reader deliberately.`,
    );
  }

  const events: RawEvent[] = [];

  // Pair before/after by callId; keep only Frame actions + goto.
  const pending = new Map<string, { api: string; selector?: string; value?: string; url?: string; startMs: number }>();
  for (const l of lines) {
    if (l.type === 'before' && l.class === 'Frame') {
      const method = String(l.method);
      const params = (l.params ?? {}) as Record<string, unknown>;
      if (method === 'goto') {
        pending.set(String(l.callId), { api: 'goto', url: asText(params.url), startMs: num(l.startTime) });
      } else if (ACTION_METHODS.has(method)) {
        pending.set(String(l.callId), compact({
          api: method,
          selector: params.selector === undefined ? undefined : asText(params.selector),
          value: params.value === undefined ? undefined : asText(params.value),
          startMs: num(l.startTime),
        }));
      }
    } else if (l.type === 'after' && pending.has(String(l.callId))) {
      const p = pending.get(String(l.callId))!;
      pending.delete(String(l.callId));
      const endMs = num(l.endTime);
      const error = extractError(l.error);
      if (p.api === 'goto') events.push(compact({ kind: 'nav', url: p.url ?? '', error, startMs: p.startMs, endMs }));
      else events.push(compact({ kind: 'action', api: p.api, selector: p.selector, value: p.value, error, startMs: p.startMs, endMs }));
    }
  }

  // Network: HAR wall-clock → the trace's monotonic clock, scoped to SF families.
  const wallAnchor = ctx.wallTime ?? 0;
  const monoAnchor = ctx.monotonicTime ?? 0;
  for (const l of ndjson(networkNdjson)) {
    if (l.type !== 'resource-snapshot') continue;
    const snap = l.snapshot as {
      startedDateTime?: string; time?: number;
      request?: { method?: string; url?: string };
      response?: { status?: number };
    };
    const url = snap.request?.url ?? '';
    if (!NETWORK_SCOPE.test(url)) continue;
    const startMs = Date.parse(snap.startedDateTime ?? '') - wallAnchor + monoAnchor;
    const durationMs = Math.max(0, snap.time ?? 0);
    events.push(compact({
      kind: 'network',
      url,
      method: snap.request?.method ?? 'GET',
      status: snap.response?.status,
      startMs,
      endMs: startMs + durationMs,
    }));
  }

  events.sort((a, b) => a.startMs - b.startMs);
  return compact({
    traceVersion: ctx.version,
    playwrightVersion: ctx.playwrightVersion,
    wallTimeMs: ctx.wallTime,
    monotonicMs: ctx.monotonicTime,
    events,
  });
}

/** After-events carry failures in a couple of shapes across versions. */
function extractError(err: unknown): string | undefined {
  if (!err) return undefined;
  if (typeof err === 'string') return err;
  const o = err as { message?: string; error?: { message?: string } };
  return o.message ?? o.error?.message ?? JSON.stringify(err);
}

/** Decode Playwright's internal selector syntax into semantic locator parts. */
export type ParsedSelector =
  | { kind: 'role'; role: string; name?: string; raw: string }
  | { kind: 'label'; text: string; raw: string }
  | { kind: 'text'; text: string; raw: string }
  | { kind: 'testid'; id: string; raw: string }
  | { kind: 'css'; css: string; raw: string }
  | { kind: 'other'; raw: string };

export function parseInternalSelector(selector: string): ParsedSelector {
  // Chained selectors ('a >> b'): the LAST hop is what the human targeted.
  const last = selector.split(' >> ').pop() ?? selector;

  let m = /^internal:role=([a-z]+)(?:\[name="([^"]*)"[si]?\])?$/.exec(last);
  if (m) return { kind: 'role', role: m[1] ?? '', ...(m[2] !== undefined ? { name: m[2] } : {}), raw: selector };

  m = /^internal:label="([^"]*)"[si]?$/.exec(last);
  if (m) return { kind: 'label', text: m[1] ?? '', raw: selector };

  m = /^internal:text="([^"]*)"[si]?$/.exec(last);
  if (m) return { kind: 'text', text: m[1] ?? '', raw: selector };

  m = /^internal:testid=\[data-testid="([^"]*)"[si]?\]$/.exec(last);
  if (m) return { kind: 'testid', id: m[1] ?? '', raw: selector };

  if (!last.startsWith('internal:')) return { kind: 'css', css: last, raw: selector };
  return { kind: 'other', raw: selector };
}

function ndjson(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0;
}

function findOne(dir: string, re: RegExp, optional = false): string {
  const hit = fs.readdirSync(dir).find((f) => re.test(f));
  if (!hit) {
    if (optional) return '';
    throw new Error(`no ${re} file inside the trace zip — unexpected trace layout`);
  }
  return path.join(dir, hit);
}
