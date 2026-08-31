import { test, expect } from '@playwright/test';
import { uniqueName, sweepPattern, sanitize, runId } from '../../src/utils/naming';

test.describe('naming', () => {
  test('uniqueName embeds prefix, run id, base and sequence', () => {
    const n = uniqueName('Acme Corp');
    expect(n).toMatch(new RegExp(`^E2E_${runId()}_Acme_Corp_\\d+$`));
  });

  test('uniqueName increments per call (parallel-collision safety)', () => {
    const a = uniqueName('X');
    const b = uniqueName('X');
    expect(a).not.toBe(b);
  });

  test('custom prefix is honoured', () => {
    expect(uniqueName('Y', 'SMOKE')).toMatch(/^SMOKE_/);
  });

  test('sweepPattern matches what uniqueName produces (SOQL LIKE)', () => {
    const name = uniqueName('Cleanup');
    const like = sweepPattern();
    // emulate SOQL LIKE: prefix% match
    expect(name.startsWith(like.slice(0, -1))).toBe(true);
    expect(like.endsWith('%')).toBe(true);
  });

  test('sanitize strips SOQL-hostile characters and collapses whitespace', () => {
    expect(sanitize("O'Brien & Sons  Ltd.")).toBe('OBrien_Sons_Ltd');
    expect(sanitize('  spaced   out ')).toBe('spaced_out');
  });
});
