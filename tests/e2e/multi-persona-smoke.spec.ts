/**
 * Real-org smoke: the Cast machinery against a live sandbox.
 * Env-gated — skips cleanly per persona until its .env credentials exist,
 * so `npm test`/`npm run test:e2e` stay green on a fresh clone.
 *
 * What it proves the moment creds land:
 *  1. token/UI-login ladder mints a session per persona (storageState saved
 *     to .auth/ — subsequent runs attach in ~100ms with no login UI)
 *  2. two personas are live simultaneously against the real org
 *  3. each session lands in LEX as an authenticated user (not the login page)
 */
import { test, expect } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import { hasOrgConfig } from '../../src/utils/env';

const registry = (() => {
  try {
    return PersonaRegistry.load();
  } catch {
    return undefined;
  }
})();

test.describe('multi-persona smoke @real-org', () => {
  test.skip(!hasOrgConfig() || !registry, 'SF org env not configured — see .env.example / SETUP-REAL-ORG.md');

  test('admin session lands authenticated in LEX', async ({ cast }) => {
    test.skip(!registry!.hasCreds('admin'), 'set SF_ADMIN_* (or legacy SF_*) in .env');
    const page = await cast.as('admin');
    await page.goto('/lightning/page/home');
    await expect(page).not.toHaveURL(/\/login|\/secur|frontdoor/);
    // LEX global header renders only for an authenticated session:
    await expect(page.getByRole('navigation', { name: /global/i }).or(page.locator('one-appnav'))).toBeVisible({ timeout: 30_000 });
  });

  test('two personas hold live sessions at once', async ({ cast }) => {
    test.skip(
      !registry!.hasCreds('admin') || !registry!.hasCreds('sales_user'),
      'set SF_ADMIN_* and SF_SALES_* in .env',
    );
    const admin = await cast.as('admin');
    const sales = await cast.as('sales_user');

    await admin.goto('/lightning/page/home');
    await sales.goto('/lightning/page/home');
    await expect(admin).not.toHaveURL(/\/login|\/secur/);
    await expect(sales).not.toHaveURL(/\/login|\/secur/);
    expect(cast.active().sort()).toEqual(['admin', 'sales_user']);

    // Sessions are distinct cookie jars — different sid values per context:
    const adminSid = (await cast.contextOf('admin').cookies()).find((c) => c.name === 'sid')?.value;
    const salesSid = (await cast.contextOf('sales_user').cookies()).find((c) => c.name === 'sid')?.value;
    expect(adminSid, 'admin session cookie missing').toBeTruthy();
    expect(salesSid, 'sales session cookie missing').toBeTruthy();
    expect(adminSid).not.toBe(salesSid);
  });

  test('portal persona attaches on the site domain', async ({ cast }) => {
    test.skip(!process.env.SF_SITE_URL || !registry!.hasCreds('portal_user'), 'set SF_SITE_URL + SF_PORTAL_* in .env');
    const portal = await cast.as('portal_user');
    await portal.goto(process.env.SF_SITE_URL!);
    await expect(portal).not.toHaveURL(/\/login\b/);
  });
});
