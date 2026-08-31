/**
 * Condition-based waiting (founding doc §6). Never networkidle, never
 * waitForTimeout — LEX never reaches network quiescence and fixed sleeps
 * are guesses. Every wait here names the condition it awaits.
 */

import { expect, type Locator, type Page } from '@playwright/test';

const SPINNER = '.slds-spinner';

/** Wait until no SLDS spinners remain in scope (page or a region locator). */
export async function waitForSpinnersGone(
  scope: Page | Locator,
  timeout = 30_000,
): Promise<void> {
  await expect(scope.locator(SPINNER)).toHaveCount(0, { timeout });
}

/** True for Aura action endpoints across LEX and portals (incl. custom site prefixes). */
export function isAuraActionUrl(url: string): boolean {
  return /\/aura(\?|$)|\/sfsites\/aura/.test(url);
}

/**
 * Surgical wait on the Aura boxcar round-trip. Portals use /s/sfsites/aura.
 * Set this promise up BEFORE triggering the action. Wait on status/URL only:
 * the boxcar envelope multiplexes unrelated actions — never assert payloads
 * (founding doc §3.4). Assert app state or query the REST API instead.
 */
export function auraResponsePromise(page: Page, timeout = 30_000) {
  return page.waitForResponse(
    (r) => isAuraActionUrl(r.url()) && r.request().method() === 'POST',
    { timeout },
  );
}
