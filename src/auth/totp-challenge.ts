/**
 * S14 — generic TOTP challenge handling for UI logins. Implementation-
 * agnostic by design: detection is a selector union covering the common
 * shapes (Salesforce's #tc verify screen, autocomplete="one-time-code",
 * otp/verification/code-named inputs), overridable per call; submit prefers
 * a verify/continue button and falls back to pressing Enter in the field.
 *
 * Outcomes are explicit — the caller decides what a challenge without a
 * secret means (the Cast turns it into a "set <ENV> in .env" error):
 *   'none'                 no challenge appeared within the detect window
 *   'filled'               challenge answered and submitted
 *   'challenged-no-secret' challenge on screen but no code source given
 */
import type { Page } from '@playwright/test';

export interface TotpChallengeOptions {
  /** Produces the code at FILL time (codes age — never precompute). */
  getCode?: () => string | Promise<string>;
  /** How long to wait for a challenge to show before deciding 'none'. */
  detectTimeoutMs?: number;
  /** Override when a system's challenge input defies the common shapes. */
  inputSelector?: string;
  submitSelector?: string;
}

export const DEFAULT_TOTP_INPUT_SELECTOR = [
  'input[autocomplete="one-time-code"]',
  'input[name="tc"]', // Salesforce "Verify Your Identity"
  '#tc',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="totp" i]',
  'input[name*="code" i]:not([type="hidden"])',
].join(', ');

export type TotpChallengeResult = 'none' | 'filled' | 'challenged-no-secret';

export async function handleTotpChallenge(page: Page, opts: TotpChallengeOptions = {}): Promise<TotpChallengeResult> {
  const input = page.locator(opts.inputSelector ?? DEFAULT_TOTP_INPUT_SELECTOR).first();
  try {
    await input.waitFor({ state: 'visible', timeout: opts.detectTimeoutMs ?? 4000 });
  } catch {
    return 'none'; // no challenge — the login sailed through
  }
  if (!opts.getCode) return 'challenged-no-secret';

  const code = await opts.getCode();
  await input.fill(code);

  if (opts.submitSelector) {
    await page.locator(opts.submitSelector).first().click();
    return 'filled';
  }
  const button = page
    .getByRole('button', { name: /verify|continue|submit|next|save/i })
    .or(page.locator('input[type="submit"], button[type="submit"]'))
    .first();
  if (await button.isVisible().catch(() => false)) {
    await button.click();
  } else {
    await input.press('Enter'); // minimal challenge forms submit on Enter
  }
  return 'filled';
}
