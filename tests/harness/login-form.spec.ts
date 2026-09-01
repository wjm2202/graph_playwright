/**
 * fillLoginForm — the auth ladder's UI tier against both login shapes it
 * claims to know, on local markup (no org): Salesforce-style labeled form
 * and Siebel OpenUI's s_swepi_* trio. Also pins the settle contract: submit
 * resolves only when the password field leaves the page, and a page that
 * keeps it (bad creds / unknown markup) fails loudly instead of hanging the
 * ladder silently.
 */
import { test, expect } from '@playwright/test';
import { fillLoginForm } from '../../src/auth/loginForm';

const SF_PAGE = `
  <form onsubmit="this.style.display='none'; return false">
    <label>Username <input name="u"></label>
    <label>Password <input name="p" type="password"></label>
    <button type="submit">Log In</button>
  </form>
  <script>
    window.submitted = () => document.querySelector('form').style.display === 'none';
  </script>`;

const SIEBEL_PAGE = `
  <table><tr>
    <td><input id="s_swepi_1"></td>
    <td><input id="s_swepi_2" type="password"></td>
    <td><input id="s_swepi_22" type="submit" value="Login"
        onclick="document.getElementById('s_swepi_2').style.display='none'; window.clicked = true; return false"></td>
  </tr></table>`;

test('salesforce-shaped form: labels found, filled, submitted, settle on password leaving', async ({ page }) => {
  await page.setContent(SF_PAGE);
  await fillLoginForm(page, { username: 'user@org.example', password: 'pw' });
  expect(await page.evaluate('window.submitted()')).toBe(true);
});

test('siebel OpenUI shape: the s_swepi_* trio works without any labels', async ({ page }) => {
  await page.setContent(SIEBEL_PAGE);
  await fillLoginForm(page, { username: 'SADMIN', password: 'pw' });
  expect(await page.locator('#s_swepi_1').inputValue()).toBe('SADMIN');
  expect(await page.evaluate('window.clicked')).toBe(true);
  await expect(page.locator('#s_swepi_2')).toBeHidden();
});

test('a login page that KEEPS its password field fails loudly at the timeout', async ({ page }) => {
  // Submit does nothing — wrong-creds / unknown-markup stand-in.
  await page.setContent(`
    <input id="username"><input id="password" type="password">
    <button id="Login" onclick="return false">Log In</button>`);
  await expect(
    fillLoginForm(page, { username: 'u', password: 'p' }, { submitTimeoutMs: 500 }),
  ).rejects.toThrow(/waiting for|Timeout/i);
});
