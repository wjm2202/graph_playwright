/**
 * Toast component object vs auto-dismissing toast (founding doc §3.2):
 * platform toasts dismiss at 4.8s — harness uses 1.5s to prove the
 * assert-immediately discipline works against a disappearing target.
 */
import { test } from '@playwright/test';
import { Toast } from '../../src/components/Toast';

const TOAST_PAGE = `
  <button id="save">Save</button>
  <div id="toast-container" class="slds-notify_container"></div>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      setTimeout(() => {  // simulate save round-trip
        const t = document.createElement('div');
        t.className = 'slds-notify slds-notify_toast slds-theme_success';
        t.textContent = 'Account "Acme" was created.';
        document.getElementById('toast-container').append(t);
        setTimeout(() => t.remove(), 1500);  // auto-dismiss
      }, 200);
    });
  </script>
`;

test('expectMessage catches the toast inside its dismiss window', async ({ page }) => {
  await page.setContent(TOAST_PAGE);
  const toast = new Toast(page);

  await page.getByRole('button', { name: 'Save' }).click();
  await toast.expectMessage(/was created/);
  await toast.expectSuccess();
});

test('error theme is distinguished from success', async ({ page }) => {
  await page.setContent(TOAST_PAGE.replace('slds-theme_success', 'slds-theme_error'));
  const toast = new Toast(page);

  await page.getByRole('button', { name: 'Save' }).click();
  await toast.expectError();
});
