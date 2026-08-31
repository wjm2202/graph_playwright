/**
 * R1 — recording plumbing: env parsing, artifact paths, manifest shape,
 * HAR scoping. (The headed session itself is human-driven; its plumbing is
 * what must never be the flaky part.)
 */
import { test, expect } from '@playwright/test';
import { parseRecordEnv, recordingDirFor, buildManifest, HAR_URL_FILTER } from '../../src/pipeline/recording';

const personas = ['admin', 'sales_user', 'portal_user', 'guest'];

test.describe('parseRecordEnv', () => {
  test('valid config parses, denial flag defaults off', () => {
    const r = parseRecordEnv({ RECORD_JOURNEY: 'expense_v2', RECORD_PERSONA: 'sales_user' }, personas);
    expect(r).toEqual({ ok: true, value: { journey: 'expense_v2', persona: 'sales_user', expectDenial: false } });
  });

  test('denial flag accepts 1/true', () => {
    for (const v of ['1', 'true']) {
      const r = parseRecordEnv(
        { RECORD_JOURNEY: 'j', RECORD_PERSONA: 'admin', RECORD_EXPECT_DENIAL: v },
        personas,
      );
      expect(r.ok && r.value.expectDenial).toBe(true);
    }
  });

  test('every problem is reported at once, with the known personas listed', () => {
    const r = parseRecordEnv({ RECORD_JOURNEY: 'Bad-Name', RECORD_PERSONA: 'ghost', RECORD_EXPECT_DENIAL: 'yep' }, personas);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toHaveLength(3);
      expect(r.errors.join()).toContain('lower_snake_case');
      expect(r.errors.join()).toContain('personas.json has: admin, sales_user, portal_user, guest');
      expect(r.errors.join()).toContain('1/0/true/false');
    }
  });

  test('missing config yields required-field errors', () => {
    const r = parseRecordEnv({}, personas);
    expect(!r.ok && r.errors.join()).toContain('RECORD_JOURNEY is required');
    expect(!r.ok && r.errors.join()).toContain('RECORD_PERSONA is required');
  });
});

test.describe('artifact conventions', () => {
  test('recordingDirFor: recordings/<journey>/<persona>-<YYYYMMDD-HHMMSS>', () => {
    const when = new Date('2026-08-30T14:15:30.123Z');
    expect(recordingDirFor('expense_v2', 'sales_user', when)).toBe(
      ['recordings', 'expense_v2', 'sales_user-20260830-141530'].join(require('path').sep),
    );
  });

  test('manifest carries schema tag, timing, playwright version, file names', () => {
    const m = buildManifest({
      env: { journey: 'j', persona: 'admin', expectDenial: true },
      startedAt: new Date('2026-08-30T10:00:00Z'),
      endedAt: new Date('2026-08-30T10:05:00Z'),
      playwrightVersion: '1.55.0',
    });
    expect(m).toEqual({
      schema: 'sf-recording/1',
      journey: 'j',
      persona: 'admin',
      expectDenial: true,
      startedAt: '2026-08-30T10:00:00.000Z',
      endedAt: '2026-08-30T10:05:00.000Z',
      playwrightVersion: '1.55.0',
      files: { trace: 'trace.zip', har: 'network.har' },
    });
  });

  test('HAR filter matches the aura/services families and lightning nav, not noise', () => {
    for (const hit of [
      'https://org.my.salesforce.com/aura?r=1',
      'https://site.my.site.com/s/sfsites/aura',
      'https://org.my.salesforce.com/services/data/v61.0/sobjects/Account',
      'https://org.lightning.force.com/lightning/r/Account/001xx/view',
    ]) {
      expect(HAR_URL_FILTER.test(hit), hit).toBe(true);
    }
    for (const miss of [
      'https://static.lightning.force.com/assets/icons.svg',
      'https://org.my.salesforce.com/analytics/beacon',
    ]) {
      expect(HAR_URL_FILTER.test(miss), miss).toBe(false);
    }
  });
});
