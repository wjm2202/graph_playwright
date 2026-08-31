/**
 * Proves the two load-bearing L2 claims about locators (founding doc §3.1):
 *  1. Playwright CSS/role/label locators pierce OPEN shadow roots.
 *  2. XPath does NOT pierce shadow roots.
 * If a Playwright upgrade ever changes this, these tests fail first.
 */
import { test, expect } from '@playwright/test';

const SHADOW_PAGE = `
  <div id="host-container"></div>
  <script>
    const host = document.createElement('c-hello-input');
    host.attachShadow({ mode: 'open' }).innerHTML = \`
      <label for="uname">Username</label>
      <input id="uname" type="text" />
      <button>Save</button>
    \`;
    document.getElementById('host-container').append(host);
  </script>
`;

test('role/label/CSS locators pierce open shadow DOM', async ({ page }) => {
  await page.setContent(SHADOW_PAGE);

  await page.getByLabel('Username').fill('entity.one');
  await expect(page.getByLabel('Username')).toHaveValue('entity.one');
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  // CSS descendant combinator crosses the shadow boundary transparently:
  await expect(page.locator('c-hello-input input')).toHaveValue('entity.one');
});

test('XPath does NOT pierce shadow DOM — the founding-doc anti-pattern, demonstrated', async ({ page }) => {
  await page.setContent(SHADOW_PAGE);

  await expect(page.getByLabel('Username')).toBeVisible(); // element exists…
  await expect(page.locator('xpath=//input')).toHaveCount(0); // …but XPath can't see it
});
