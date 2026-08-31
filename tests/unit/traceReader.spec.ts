/**
 * R2 — trace reader against the COMMITTED fixture (tests/fixtures/trace-demo),
 * generated in-repo by make-fixture-trace.spec.ts. If a Playwright upgrade
 * changes the trace format, these tests fail first — regenerate the fixture
 * and extend the reader deliberately (never silently).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import {
  readTrace, parseTraceFiles, parseInternalSelector,
  SUPPORTED_TRACE_VERSIONS, NETWORK_SCOPE, type RawEvent,
} from '../../src/pipeline/traceReader';

const FIXTURE = path.resolve(__dirname, '../fixtures/trace-demo/trace.zip');

test.describe('readTrace on the committed fixture', () => {
  test('parses version, actions, navigation, and scoped network in order', () => {
    const data = readTrace(FIXTURE);
    expect(SUPPORTED_TRACE_VERSIONS).toContain(data.traceVersion);

    const kinds = data.events.map((e) => `${e.kind}:${e.kind === 'action' ? e.api : e.kind === 'nav' ? 'goto' : (e as RawEvent & { method: string }).method}`);
    // nav + page GET land first (same moment), then the human's actions, then the aura POST.
    expect(kinds.slice(0, 2).sort()).toEqual(['nav:goto', 'network:GET']);
    expect(kinds.slice(2)).toEqual(['action:fill', 'action:click', 'action:click', 'action:click', 'network:POST']);

    const [fill] = data.events.filter((e) => e.kind === 'action' && e.api === 'fill');
    expect(fill).toMatchObject({ selector: 'internal:label="Amount"i', value: '4999' });

    const clicks = data.events.filter((e): e is Extract<RawEvent, { kind: 'action' }> => e.kind === 'action' && e.api === 'click');
    expect(clicks.map((c) => c.selector)).toEqual([
      'internal:role=combobox[name="Stage"i]',
      'internal:role=option[name="Closed Won"i]',
      'internal:role=button[name="Save"i]',
    ]);

    const nav = data.events.find((e) => e.kind === 'nav');
    expect(nav).toMatchObject({ url: 'https://fixture.test/lightning/r/Account/001FIXTURE0000001/view' });

    const aura = data.events.find((e) => e.kind === 'network' && e.url.includes('/aura'));
    expect(aura).toMatchObject({ method: 'POST', status: 200 });

    // The aura burst STARTS after the Save click starts — attribution holds.
    const save = clicks[2];
    expect(aura!.startMs).toBeGreaterThan(save!.startMs);

    // Durations are sane, monotonic, and non-negative.
    for (const e of data.events) expect(e.endMs).toBeGreaterThanOrEqual(e.startMs);
  });

  test('infrastructure noise is filtered (routing, waits, tracing calls)', () => {
    const data = readTrace(FIXTURE);
    const apis = data.events.filter((e) => e.kind === 'action').map((e) => (e as { api: string }).api);
    expect(apis).not.toContain('fulfill');
    expect(apis).not.toContain('setNetworkInterceptionPatterns');
    expect(apis).not.toContain('__waitInfo__');
  });
});

test.describe('version pinning', () => {
  test('unknown trace version fails loudly with the pinned message', () => {
    const tampered = JSON.stringify({ type: 'context-options', version: 99, playwrightVersion: '9.9.9' });
    expect(() => parseTraceFiles(tampered, '')).toThrow(
      /unsupported trace format version 99 \(playwright 9\.9\.9\).*pinned to version\(s\) 8/,
    );
  });

  test('a non-trace input fails with a truncation message, not a crash', () => {
    expect(() => parseTraceFiles('{"type":"before","callId":"x"}', '')).toThrow(/no context-options header/);
  });

  test('missing zip fails with the path', () => {
    expect(() => readTrace('/nope/missing.zip')).toThrow(/trace not found: \/nope\/missing.zip/);
  });
});

test.describe('parseInternalSelector', () => {
  test('role + accessible name', () => {
    expect(parseInternalSelector('internal:role=button[name="Save"i]')).toEqual({
      kind: 'role', role: 'button', name: 'Save', raw: 'internal:role=button[name="Save"i]',
    });
    // No accessible name → the key is ABSENT (exactOptionalPropertyTypes), not explicitly undefined.
    const unnamed = parseInternalSelector('internal:role=listbox');
    expect(unnamed).toMatchObject({ kind: 'role', role: 'listbox' });
    expect('name' in unnamed).toBe(false);
  });

  test('label, text, testid', () => {
    expect(parseInternalSelector('internal:label="Amount"i')).toMatchObject({ kind: 'label', text: 'Amount' });
    expect(parseInternalSelector('internal:text="Closed Won"i')).toMatchObject({ kind: 'text', text: 'Closed Won' });
    expect(parseInternalSelector('internal:testid=[data-testid="save-btn"s]')).toMatchObject({ kind: 'testid', id: 'save-btn' });
  });

  test('chained selectors resolve to the final hop (what the human targeted)', () => {
    const p = parseInternalSelector('internal:role=dialog >> internal:label="Amount"i');
    expect(p).toMatchObject({ kind: 'label', text: 'Amount' });
    expect(p.raw).toContain('internal:role=dialog');
  });

  test('css and unknown internal engines are preserved, never mangled', () => {
    expect(parseInternalSelector('lightning-combobox')).toMatchObject({ kind: 'css', css: 'lightning-combobox' });
    expect(parseInternalSelector('internal:something=weird')).toMatchObject({ kind: 'other' });
  });
});

test.describe('network scope', () => {
  test('keeps SF families, drops beacons/static', () => {
    expect(NETWORK_SCOPE.test('https://x.my.salesforce.com/aura?r=2')).toBe(true);
    expect(NETWORK_SCOPE.test('https://x.my.site.com/s/sfsites/aura')).toBe(true);
    expect(NETWORK_SCOPE.test('https://x.my.salesforce.com/services/data/v61.0/query')).toBe(true);
    expect(NETWORK_SCOPE.test('https://x.lightning.force.com/lightning/r/Account/1/view')).toBe(true);
    expect(NETWORK_SCOPE.test('https://static.force.com/assets/x.png')).toBe(false);
  });
});
