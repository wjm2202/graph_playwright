/**
 * Modal component object: everything scoped to role=dialog so strict mode
 * never collides with same-named elements behind the modal (founding doc §7).
 */
import { test, expect } from '@playwright/test';
import { Modal } from '../../src/components/Modal';

const MODAL_PAGE = `
  <!-- page-behind decoys with the SAME names the modal uses -->
  <button>Save</button>
  <label for="bg-name">Opportunity Name</label><input id="bg-name" />

  <section role="dialog" aria-modal="true" id="dlg">
    <h2>New Opportunity</h2>
    <label for="opp-name">Opportunity Name</label>
    <input id="opp-name" />
    <footer>
      <button id="save">Save</button>
    </footer>
  </section>
  <script>
    document.getElementById('save').addEventListener('click', () => {
      setTimeout(() => { document.getElementById('dlg').style.display = 'none'; }, 150);
    });
  </script>
`;

test('dialog scoping defeats duplicate labels/buttons on the page behind', async ({ page }) => {
  await page.setContent(MODAL_PAGE);
  const modal = new Modal(page);

  await modal.expectOpen('New Opportunity');
  await modal.fillLabel('Opportunity Name', 'Enterprise Deal');
  // the decoy input outside the dialog is untouched:
  await expect(page.locator('#bg-name')).toHaveValue('');
  await expect(page.locator('#opp-name')).toHaveValue('Enterprise Deal');
});

test('saveAndExpectClosed asserts the modal actually went away', async ({ page }) => {
  await page.setContent(MODAL_PAGE);
  const modal = new Modal(page);

  await modal.expectOpen();
  await modal.saveAndExpectClosed('Save', 5_000);
});
