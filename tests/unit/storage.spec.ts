import { test, expect } from '@playwright/test';
import { statePathFor, workerStatePathFor, GUEST_STATE, AUTH_DIR } from '../../src/auth/storage';

test.describe('storage-state paths', () => {
  test('persona path is slugged and lives in .auth/', () => {
    expect(statePathFor('Partner User')).toBe(`${AUTH_DIR}/partner-user.json`);
    expect(statePathFor('admin')).toBe(`${AUTH_DIR}/admin.json`);
  });

  test('worker path embeds the parallel index (one user per worker)', () => {
    expect(workerStatePathFor('sales', 2)).toBe(`${AUTH_DIR}/sales-w2.json`);
  });

  test('worker path rejects invalid indexes', () => {
    expect(() => workerStatePathFor('sales', -1)).toThrow(/non-negative/);
    expect(() => workerStatePathFor('sales', 1.5)).toThrow(/non-negative/);
  });

  test('empty persona rejected', () => {
    expect(() => statePathFor('  ')).toThrow(/non-empty/);
  });

  test('guest state is empty (unauthenticated portal project)', () => {
    expect(GUEST_STATE.cookies).toHaveLength(0);
    expect(GUEST_STATE.origins).toHaveLength(0);
  });
});
