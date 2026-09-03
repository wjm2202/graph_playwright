/**
 * R5 + R6 — denial evidence extraction, deny-mode generation (incl. the
 * captured-success refusal), reader error capture, wall-clock stitching with
 * actor attribution and cross-actor id flags, and multi-actor generation.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractDenialEvidence, summarizeEvidence } from '../../src/pipeline/denial';
import { parseTraceFiles, type RawEvent } from '../../src/pipeline/traceReader';
import { stitchRecordings } from '../../src/pipeline/stitch';
import { generateArtifacts } from '../../src/pipeline/generate';
import { validateJourney } from '../../src/journeys/schema';
import type { Distillation } from '../../src/pipeline/distill';

const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest'];

const net = (url: string, status: number, method = 'POST'): RawEvent =>
  ({ kind: 'network', url, method, status, startMs: 10, endMs: 20 });

function outDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-'));
  return {
    root,
    dirs: {
      journeys: path.join(root, 'j'),
      stubs: path.join(root, 's'),
      baselines: path.join(root, 'b'),
      encoding: path.join(root, 'e'),
    },
  };
}

const emptyDistillation = (): Distillation => ({ steps: [], harvestedIds: [], flags: [] });

test.describe('R5 — denial evidence', () => {
  test('4xx on aura/services families is api-refusal; 2xx and off-family are not', () => {
    const ev = extractDenialEvidence([
      net('https://x.my.salesforce.com/aura?r=1', 403),
      net('https://x.my.salesforce.com/services/data/v61.0/sobjects/Expense__c', 400),
      net('https://x.my.salesforce.com/aura?r=2', 200),
      net('https://x.my.salesforce.com/analytics/beacon', 500),
    ]);
    expect(ev).toEqual([
      { kind: 'api-refusal', status: 403, method: 'POST', url: 'https://x.my.salesforce.com/aura?r=1' },
      { kind: 'api-refusal', status: 400, method: 'POST', url: 'https://x.my.salesforce.com/services/data/v61.0/sobjects/Expense__c' },
    ]);
  });

  test('failed actions are ui-blocked evidence', () => {
    const ev = extractDenialEvidence([
      { kind: 'action', api: 'click', selector: 'internal:role=button[name="Approve"i]', error: 'strict mode: no elements match', startMs: 0, endMs: 5 },
      { kind: 'action', api: 'click', selector: 'internal:role=button[name="Save"i]', startMs: 6, endMs: 9 },
    ]);
    expect(ev).toEqual([
      { kind: 'ui-blocked', api: 'click', selector: 'internal:role=button[name="Approve"i]', message: 'strict mode: no elements match' },
    ]);
    expect(summarizeEvidence(ev)).toContain('UI blocked: click');
  });

  test('the reader captures after-event errors in both known shapes', () => {
    const trace = [
      JSON.stringify({ type: 'context-options', version: 8, wallTime: 1000, monotonicTime: 0 }),
      JSON.stringify({ type: 'before', callId: 'c1', startTime: 1, class: 'Frame', method: 'click', params: { selector: 'internal:role=button[name="Approve"i]' } }),
      JSON.stringify({ type: 'after', callId: 'c1', endTime: 2, error: { message: 'timeout waiting for element' } }),
      JSON.stringify({ type: 'before', callId: 'c2', startTime: 3, class: 'Frame', method: 'click', params: { selector: 'internal:role=button[name="Delete"i]' } }),
      JSON.stringify({ type: 'after', callId: 'c2', endTime: 4, error: { error: { message: 'nested-shape failure' } } }),
    ].join('\n');
    const data = parseTraceFiles(trace, '');
    const actions = data.events.filter((e) => e.kind === 'action');
    expect(actions.map((a) => (a as { error?: string }).error)).toEqual([
      'timeout waiting for element',
      'nested-shape failure',
    ]);
    expect(data.wallTimeMs).toBe(1000);
    expect(data.monotonicMs).toBe(0);
  });

  test('deny mode emits the deny journey + a loudly-unimplemented probe stub', () => {
    const { root, dirs } = outDirs();
    try {
      const result = generateArtifacts(emptyDistillation(), {
        journeyId: 'approve_denied',
        persona: 'sales_user',
        personaIds: PERSONAS,
        deny: {
          capability: 'expense.approve',
          target: '{ref:expense.id}',
          evidence: [{ kind: 'api-refusal', status: 403, method: 'POST', url: 'https://x/aura' }],
        },
        outDirs: dirs,
        today: '2026-08-30',
      });

      const journey = JSON.parse(fs.readFileSync(result.journeyFile, 'utf8'));
      expect(validateJourney(journey, { personaIds: PERSONAS }).errors).toEqual([]);
      expect(journey.steps).toEqual([
        { deny: { actor: 'main', capability: 'expense.approve', target: '{ref:expense.id}' } },
      ]);

      const stub = fs.readFileSync(result.stubsFile, 'utf8');
      expect(stub).toContain("registerDeny(\"expense.approve\"");
      expect(stub).toContain('API refused: POST https://x/aura → 403');
      expect(stub).toContain('throws until implemented');

      expect(result.baselinesFile).toBeUndefined();
      expect(result.flags.join()).toContain("deny 'expense.approve' evidenced by");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a captured SUCCESS refuses to generate — security holes are not expectations', () => {
    const { root, dirs } = outDirs();
    try {
      expect(() =>
        generateArtifacts(emptyDistillation(), {
          journeyId: 'leak',
          persona: 'sales_user',
          personaIds: PERSONAS,
          deny: { capability: 'expense.approve', evidence: [] },
          outDirs: dirs,
        }),
      ).toThrow(/expected a denial, captured success.*Refusing to encode a security hole/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('R6 — multi-actor stitch', () => {
  const stepAt = (catalog: string, startMs: number, args: Record<string, unknown> = {}): Distillation['steps'][0] => ({
    kind: 'step', catalog, args, startMs, endMs: startMs + 10, durationMs: 10, recognized: true, sourceEvents: [],
  });

  test('interleaves on absolute wall time with actor attribution', () => {
    const submitter: Distillation = {
      steps: [stepAt('expense.submit', 100)], // wall offset +0 → abs 100
      harvestedIds: [{ id: 'a03xx0000012AbCDEF', sobject: 'Expense__c', firstEvent: 0 }],
      flags: [],
    };
    const approver: Distillation = {
      steps: [stepAt('expense.approve', 50)], // wall offset +1000 → abs 1050 (acts SECOND)
      harvestedIds: [{ id: 'a03xx0000012AbCDEF', sobject: 'Expense__c', firstEvent: 0 }],
      flags: [],
    };

    const stitched = stitchRecordings([
      { alias: 'submitter', persona: 'sales_user', distillation: submitter, wallOffsetMs: 0 },
      { alias: 'approver', persona: 'admin', distillation: approver, wallOffsetMs: 1000 },
    ]);

    expect(stitched.actors).toEqual({ submitter: 'sales_user', approver: 'admin' });
    expect(stitched.distillation.steps.map((s) => `${s.actorAlias}:${s.catalog}@${s.startMs}`)).toEqual([
      'submitter:expense.submit@100',
      'approver:expense.approve@1050',
    ]);
    expect(stitched.distillation.flags.join()).toContain(
      'cross-actor record a03xx0000012AbCDEF touched by [submitter, approver]',
    );
  });

  test('stitch input validation reports everything at once', () => {
    const d = emptyDistillation();
    expect(() =>
      stitchRecordings([
        { alias: 'Bad Alias', persona: '', distillation: d, wallOffsetMs: Number.NaN },
        { alias: 'dup', persona: 'admin', distillation: d, wallOffsetMs: 0 },
        { alias: 'dup', persona: 'admin', distillation: d, wallOffsetMs: 0 },
      ]),
    ).toThrow(/lower_snake_case[\s\S]*persona required[\s\S]*wallOffsetMs missing[\s\S]*duplicate alias 'dup'/);
    expect(() => stitchRecordings([])).toThrow(/no recordings given/);
  });

  test('stitched distillation generates a valid multi-actor journey with per-actor baselines', () => {
    const { root, dirs } = outDirs();
    try {
      const stitched = stitchRecordings([
        {
          alias: 'submitter', persona: 'sales_user', wallOffsetMs: 0,
          distillation: { steps: [stepAt('form.fill', 100, { label: 'Amount', value: '4999' })], harvestedIds: [], flags: [] },
        },
        {
          alias: 'approver', persona: 'admin', wallOffsetMs: 500,
          distillation: { steps: [stepAt('ui.click', 100, { role: 'button', name: 'Approve' })], harvestedIds: [], flags: [] },
        },
      ]);

      const result = generateArtifacts(stitched.distillation, {
        journeyId: 'stitched_demo',
        actors: stitched.actors,
        personaIds: PERSONAS,
        outDirs: dirs,
        today: '2026-08-30',
      });

      const journey = JSON.parse(fs.readFileSync(result.journeyFile, 'utf8'));
      expect(validateJourney(journey, { personaIds: PERSONAS }).errors).toEqual([]);
      expect(journey.actors).toEqual({ submitter: 'sales_user', approver: 'admin' });
      expect(journey.steps.map((s: { actor: string; do: string }) => `${s.actor}:${s.do}`)).toEqual([
        'submitter:form.fill',
        'approver:ui.click',
      ]);

      const b = JSON.parse(fs.readFileSync(result.baselinesFile!, 'utf8'));
      expect(Object.keys(b.steps)).toEqual(['0:submitter/form.fill', '1:approver/ui.click']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
