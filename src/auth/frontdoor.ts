/**
 * Session injection — the #1 auth pattern (founding doc §4).
 *
 * Tier 1: token → frontdoor.jsp (classic) or UI Bridge singleaccess (modern,
 * single-use, ≤60s validity, works on Experience Cloud site domains).
 * Never per-test UI login.
 *
 * Volatile facts to re-verify each release (founding doc §13):
 *  - `?sid=` still documented as working (May 2026) but under deprecation
 *    pressure; UI Bridge is the recommended path for new implementations.
 *  - Test user must NOT have "API Only User" (Spring '26 blocks UI bridging).
 */

import type { APIRequestContext } from '@playwright/test';

/** Classic frontdoor URL. Token needs web/full OAuth scope. */
export function buildFrontdoorUrl(
  instanceUrl: string,
  accessToken: string,
  retUrl = '/lightning/page/home',
): string {
  const base = instanceUrl.replace(/\/+$/, '');
  return `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(
    accessToken,
  )}&retURL=${encodeURIComponent(retUrl)}`;
}

/**
 * UI Bridge API: exchange an access token for a single-use frontdoor URL.
 * `domain` may be the My Domain org URL or an Experience Cloud site URL —
 * NOT login.salesforce.com / test.salesforce.com.
 * The returned URL is valid ≤1 minute and usable exactly once: navigate
 * immediately, then persist the session via storageState.
 */
export async function fetchSingleAccessUrl(
  request: APIRequestContext,
  domain: string,
  accessToken: string,
  redirectUri?: string,
): Promise<string> {
  const base = domain.replace(/\/+$/, '');
  const form: Record<string, string> = { access_token: accessToken };
  if (redirectUri) form.redirect_uri = redirectUri;
  const res = await request.post(`${base}/services/oauth2/singleaccess`, { form });
  if (!res.ok()) {
    throw new Error(
      `singleaccess failed: ${res.status()} ${await res.text().catch(() => '')} — ` +
        'check: token has web/full scope, user is not API-only, domain is a My Domain/site URL',
    );
  }
  const body = (await res.json()) as { frontdoor_uri?: string };
  if (!body.frontdoor_uri) throw new Error('singleaccess response missing frontdoor_uri');
  return body.frontdoor_uri;
}
