/**
 * Reference e2e spec — the five pillars in one journey (founding doc §1).
 * Env-gated: skips cleanly until .env is configured (see .env.example).
 *
 * Pillars on display:
 *  1. Auth by token injection (frontdoor), not UI login.
 *  2. Semantic locators only.
 *  3. Condition waits (spinners, headings) — no networkidle, no sleeps.
 *  4. Data via API with unique naming + teardown; UI for behavior only.
 *  5. Component objects via the `lightning` fixture.
 */
import { test, expect } from '../../src/fixtures/test';
import { hasOrgConfig, requireEnv } from '../../src/utils/env';
import { buildFrontdoorUrl } from '../../src/auth/frontdoor';
import { SalesforceApi } from '../../src/api/salesforceApi';
import { uniqueName } from '../../src/utils/naming';

test.skip(!hasOrgConfig(), 'Set SF_INSTANCE_URL + SF_ACCESS_TOKEN in .env to run e2e (see .env.example)');

test.describe('Account lifecycle', () => {
  let api: SalesforceApi;

  test.beforeEach(async ({ page, request }) => {
    const cfg = requireEnv();
    if (!cfg.accessToken) test.skip(true, 'This example uses SF_ACCESS_TOKEN (sf org display --json)');
    api = new SalesforceApi(request, cfg.instanceUrl, cfg.accessToken!, cfg.apiVersion);
    // Pillar 1: session injection — lands authenticated, no login form, no MFA.
    await page.goto(buildFrontdoorUrl(cfg.instanceUrl, cfg.accessToken!));
    await expect(page).toHaveURL(/lightning/, { timeout: 60_000 });
  });

  test.afterEach(async () => {
    await api?.deleteAll(); // children-first teardown of everything we created
  });

  test('API-created account renders for the test user', async ({ lightning }) => {
    // Pillar 4: data via API, unique per run.
    const name = uniqueName('Acme');
    const id = await api.create('Account', { Name: name });

    // Deep-link, then wait on app-visible readiness.
    await lightning.recordPage.open('Account', id);
    await lightning.recordPage.expectHeading(name);
  });

  test('editing an account field persists (dual-layer assertion)', async ({ page, lightning }) => {
    const name = uniqueName('Editable');
    const id = await api.create('Account', { Name: name });
    await lightning.recordPage.open('Account', id);

    // UI action: inline edit via the record page (adjust to your org's layout).
    await page.getByRole('button', { name: /Edit/ }).first().click();
    const modal = lightning.modal;
    await modal.expectOpen();
    await modal.fillLabel(/Account Name/, `${name}_edited`);
    await modal.saveAndExpectClosed();

    // Toast immediately (4.8s window), then verify the PERSISTED state via API —
    // catches silent save failures a toast-only assertion misses.
    await lightning.toast.expectMessage(/was saved|success/i);
    const rec = await api.retrieve<{ Name: string }>('Account', id);
    expect(rec.Name).toBe(`${name}_edited`);
  });
});
