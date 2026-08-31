/**
 * R7 — pipeline planner: mode selection, alias mapping, re-record precedence,
 * and every misconfiguration failing with instructions.
 */
import { test, expect } from '@playwright/test';
import { planPipeline, parseAliases, type FoundRecording } from '../../src/pipeline/cli';

const rec = (persona: string, startedAt: string, expectDenial = false): FoundRecording => ({
  dir: `recordings/j/${persona}-${startedAt}`,
  manifest: {
    schema: 'sf-recording/1',
    journey: 'j',
    persona,
    expectDenial,
    startedAt,
    endedAt: startedAt,
    playwrightVersion: '1.62.1',
    files: { trace: 'trace.zip', har: 'network.har' },
  },
});

test.describe('parseAliases', () => {
  test('parses, trims, rejects malformed and duplicates', () => {
    expect(parseAliases('submitter=sales_user, approver=admin')).toEqual({
      submitter: 'sales_user',
      approver: 'admin',
    });
    expect(parseAliases(undefined)).toEqual({});
    expect(() => parseAliases('nonsense')).toThrow(/must be alias=persona/);
    expect(() => parseAliases('a=x,a=y')).toThrow(/duplicate alias 'a'/);
  });
});

test.describe('planPipeline', () => {
  test('one recording → single mode, alias defaults to the persona', () => {
    const plan = planPipeline('j', [rec('sales_user', '2026-08-30T10:00:00Z')]);
    expect(plan).toMatchObject({ mode: 'single', alias: 'sales_user' });
  });

  test('several personas → stitch mode with explicit aliases applied', () => {
    const plan = planPipeline(
      'j',
      [rec('sales_user', '2026-08-30T10:00:00Z'), rec('admin', '2026-08-30T10:05:00Z')],
      { aliases: 'submitter=sales_user,approver=admin' },
    );
    expect(plan.mode).toBe('stitch');
    if (plan.mode === 'stitch') {
      expect(plan.recordings.map((r) => `${r.alias}:${r.manifest.persona}`)).toEqual([
        'submitter:sales_user',
        'approver:admin',
      ]);
    }
  });

  test('re-records supersede: the latest take per persona wins', () => {
    const plan = planPipeline('j', [
      rec('sales_user', '2026-08-30T10:00:00Z'),
      rec('sales_user', '2026-08-30T11:00:00Z'),
    ]);
    expect(plan).toMatchObject({ mode: 'single' });
    if (plan.mode === 'single') expect(plan.recording.manifest.startedAt).toBe('2026-08-30T11:00:00Z');
  });

  test('denial capture → deny mode, capability required', () => {
    const denial = [rec('sales_user', '2026-08-30T10:00:00Z', true)];
    expect(() => planPipeline('j', denial)).toThrow(/set PIPELINE_CAPABILITY/);
    const plan = planPipeline('j', denial, { capability: 'expense.approve' });
    expect(plan).toMatchObject({ mode: 'deny', capability: 'expense.approve', alias: 'sales_user' });
  });

  test('mixing denial and normal recordings under one journey id is refused', () => {
    expect(() =>
      planPipeline('j', [rec('sales_user', '1'), rec('admin', '2', true)], { capability: 'x' }),
    ).toThrow(/record denials under their own journey id/);
  });

  test('multiple denial captures are refused; empty journey dir instructs to record', () => {
    expect(() =>
      planPipeline('j', [rec('a', '1', true), rec('b', '2', true)], { capability: 'x' }),
    ).toThrow(/one deny step per journey id/);
    expect(() => planPipeline('j', [])).toThrow(/run `npm run record` first/);
  });
});
