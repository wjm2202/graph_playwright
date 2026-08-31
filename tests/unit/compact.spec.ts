/**
 * S15 — compact(): the exactOptionalPropertyTypes helper. Drops undefined
 * entries at runtime and in the type, preserves literals (const T), and
 * never invents or mutates anything.
 */
import { test, expect } from '@playwright/test';
import { compact } from '../../src/utils/compact';

test('drops undefined entries, keeps everything else — including falsy values', () => {
  const out = compact({ a: 1, b: undefined, c: '', d: 0, e: null, f: false });
  expect(out).toEqual({ a: 1, c: '', d: 0, e: null, f: false });
  expect('b' in out).toBe(false);
});

test('literal types survive (discriminated unions stay discriminated)', () => {
  const evt = compact({ kind: 'nav', url: 'x', error: undefined as string | undefined });
  // Type-level: kind is 'nav', not string — this assignment proves it compiles:
  const k: 'nav' = evt.kind;
  expect(k).toBe('nav');
});

test('pure: the input object is untouched', () => {
  const input = { a: 1, b: undefined };
  compact(input);
  expect(Object.keys(input)).toEqual(['a', 'b']);
});
