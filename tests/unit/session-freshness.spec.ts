/**
 * #3A — cached storageState is trusted only while it's young enough.
 * Pure given (mtime, now), so no clock, no browser, no org.
 */
import { test, expect } from '@playwright/test';
import {
  sessionFreshness,
  sessionMaxAgeMs,
  DEFAULT_SESSION_MAX_AGE_MS,
} from '../../src/auth/storage';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

test.describe('sessionFreshness', () => {
  test('a just-written session is fresh', () => {
    const f = sessionFreshness('.auth/admin.json', NOW - 5 * MIN, NOW);
    expect(f.fresh).toBe(true);
    expect(f.reason).toBeUndefined();
  });

  test('a session older than the max age is stale and says so by name', () => {
    const f = sessionFreshness('.auth/sales_user.json', NOW - 6 * 24 * HOUR, NOW);
    expect(f.fresh).toBe(false);
    // The message is the feature: the file, its age, the limit, the action.
    expect(f.reason).toContain('.auth/sales_user.json');
    expect(f.reason).toContain('6.0d');
    expect(f.reason).toContain('re-authenticating');
  });

  test('exactly at the boundary is still fresh (<= not <)', () => {
    expect(sessionFreshness('.auth/a.json', NOW - 2 * HOUR, NOW).fresh).toBe(true);
    expect(sessionFreshness('.auth/a.json', NOW - 2 * HOUR - 1, NOW).fresh).toBe(false);
  });

  test('a custom max age is honoured', () => {
    const mtime = NOW - 20 * MIN;
    expect(sessionFreshness('.auth/a.json', mtime, NOW, 15 * MIN).fresh).toBe(false);
    expect(sessionFreshness('.auth/a.json', mtime, NOW, 30 * MIN).fresh).toBe(true);
  });

  test('a future mtime (clock skew) is treated as fresh, not stale', () => {
    expect(sessionFreshness('.auth/a.json', NOW + 5 * MIN, NOW).fresh).toBe(true);
  });

  test('ages are reported in a unit a human reads at a glance', () => {
    const at = (ms: number) => sessionFreshness('.auth/a.json', NOW - ms, NOW, 0).reason!;
    expect(at(30_000)).toContain('30s');
    expect(at(45 * MIN)).toContain('45m');
    expect(at(5 * HOUR)).toContain('5.0h');
    expect(at(3 * 24 * HOUR)).toContain('3.0d');
  });
});

test.describe('sessionMaxAgeMs', () => {
  test('defaults when unset or blank', () => {
    expect(sessionMaxAgeMs({})).toBe(DEFAULT_SESSION_MAX_AGE_MS);
    expect(sessionMaxAgeMs({ SESSION_MAX_AGE_MS: '   ' })).toBe(DEFAULT_SESSION_MAX_AGE_MS);
  });

  test('reads an override', () => {
    expect(sessionMaxAgeMs({ SESSION_MAX_AGE_MS: '900000' })).toBe(900_000);
  });

  test('zero disables caching entirely (always re-authenticate)', () => {
    expect(sessionMaxAgeMs({ SESSION_MAX_AGE_MS: '0' })).toBe(0);
    expect(sessionFreshness('.auth/a.json', NOW - 1, NOW, 0).fresh).toBe(false);
  });

  test('a nonsense value fails loudly rather than silently defaulting', () => {
    expect(() => sessionMaxAgeMs({ SESSION_MAX_AGE_MS: 'two hours' })).toThrow(
      /non-negative number of milliseconds/,
    );
    expect(() => sessionMaxAgeMs({ SESSION_MAX_AGE_MS: '-1' })).toThrow();
  });
});
