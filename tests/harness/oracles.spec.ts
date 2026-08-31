/**
 * S1 harness — per-expect timeout overrides against a real page: a tight
 * timeoutMs fails FAST (no 10s stall on a hopeless check), and passing
 * content still passes under an override.
 */
import { test, expect } from '@playwright/test';
import { evaluateOracles } from '../../src/journeys/oracles';

test('ui.visible with tight timeoutMs fails fast instead of stalling 10s', async ({ page }) => {
  await page.setContent('<main><h1>Somewhere else</h1></main>');
  const t0 = Date.now();
  const [r] = await evaluateOracles(page, [
    { id: 'gone', kind: 'ui.visible', target: 'Approval granted', timeoutMs: 300 },
  ], { args: {} });
  expect(r!.status).toBe('fail');
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('override does not change a passing verdict', async ({ page }) => {
  await page.setContent('<main><p>Approval granted</p><h2>Done</h2></main>');
  const results = await evaluateOracles(page, [
    { id: 'ok', kind: 'ui.visible', target: 'Approval granted', timeoutMs: 2000 },
    { id: 'txt', kind: 'ui.text', value: 'Done', timeoutMs: 2000 },
  ], { args: {} });
  expect(results.map((r) => r.status)).toEqual(['pass', 'pass']);
});
