/**
 * Generic username/password form fill for the auth ladder's UI tier — knows
 * the two login shapes this repo meets:
 *
 *  - Salesforce: labeled inputs / #username / #password, "Log In" button
 *  - Siebel OpenUI: the s_swepi_1 / s_swepi_2 / s_swepi_22 trio (stable ids
 *    across OpenUI releases; the page has no proper labels)
 *
 * Post-submit settle: wait for the PASSWORD FIELD to leave the page. That
 * covers both worlds — Salesforce navigates away (field detaches), Siebel
 * swaps the view in place WITHOUT changing the URL path (so URL-based waits
 * pass vacuously there and prove nothing). Never networkidle (repo rule).
 * A login page that keeps its password field (bad creds, unknown markup)
 * times out here and fails loudly.
 *
 * Fallback for systems with markup neither shape matches: log in manually
 * once and let the ladder reuse the saved .auth/<persona>.json storageState.
 */

import type { Page } from '@playwright/test';

export interface LoginFormCreds {
  username: string;
  password: string;
}

export interface LoginFormOptions {
  /** How long the password field may linger after submit (default 60s). */
  submitTimeoutMs?: number;
}

export async function fillLoginForm(page: Page, creds: LoginFormCreds, opts: LoginFormOptions = {}): Promise<void> {
  const username = page
    .getByLabel(/username|user id/i)
    .or(page.locator('#username'))
    .or(page.locator('#s_swepi_1'))
    .first();
  const password = page
    .getByLabel(/password/i)
    .or(page.locator('#password'))
    .or(page.locator('#s_swepi_2'))
    .first();
  const submit = page
    .getByRole('button', { name: /log ?in|sign ?in/i })
    .or(page.locator('#Login'))
    .or(page.locator('#s_swepi_22'))
    .first();

  await username.fill(creds.username);
  await password.fill(creds.password);
  await submit.click();

  // 'hidden' resolves on detach OR invisibility — navigation and in-place
  // swaps both count. MFA interstitials also clear the password field, so
  // the TOTP handler can run right after this returns.
  await password.waitFor({ state: 'hidden', timeout: opts.submitTimeoutMs ?? 60_000 });
}
