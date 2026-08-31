/**
 * S14 harness — the generic TOTP challenge handler against real DOM:
 * Salesforce's #tc verify screen shape, the autocomplete="one-time-code"
 * shape with Enter-submit, the no-challenge fast path, and the loud
 * challenged-no-secret outcome the Cast turns into a .env instruction.
 */
import { test, expect } from '@playwright/test';
import { handleTotpChallenge } from '../../src/auth/totp-challenge';
import { totp } from '../../src/auth/totp';

const SECRET = 'JBSWY3DPEHPK3PXP';

test('salesforce-shaped verify screen: code filled and the Verify button clicked', async ({ page }) => {
  await page.setContent(`
    <h2>Verify Your Identity</h2>
    <form onsubmit="event.preventDefault(); document.body.dataset.submitted = document.getElementById('tc').value;">
      <input id="tc" name="tc" />
      <button id="save" type="submit">Verify</button>
    </form>
  `);
  const result = await handleTotpChallenge(page, { getCode: () => totp(SECRET) });
  expect(result).toBe('filled');
  const submitted = await page.evaluate(() => document.body.dataset.submitted);
  expect(submitted).toMatch(/^\d{6}$/);
  expect(submitted).toBe(totp(SECRET)); // same period — the code that was live
});

test('minimal one-time-code input with no button: Enter submits it', async ({ page }) => {
  await page.setContent(`
    <form onsubmit="event.preventDefault(); document.body.dataset.submitted = this.otp.value;">
      <input name="otp" autocomplete="one-time-code" />
    </form>
  `);
  const result = await handleTotpChallenge(page, { getCode: () => '424242' });
  expect(result).toBe('filled');
  expect(await page.evaluate(() => document.body.dataset.submitted)).toBe('424242');
});

test('no challenge on screen → none, quickly — logins without MFA lose nothing', async ({ page }) => {
  await page.setContent('<main><h1>Home</h1><p>already in</p></main>');
  const t0 = Date.now();
  expect(await handleTotpChallenge(page, { getCode: () => '000000', detectTimeoutMs: 700 })).toBe('none');
  expect(Date.now() - t0).toBeLessThan(2500);
});

test('challenge with no secret is reported, never guessed past', async ({ page }) => {
  await page.setContent('<input name="tc" id="tc" />');
  expect(await handleTotpChallenge(page, { detectTimeoutMs: 700 })).toBe('challenged-no-secret');
});
