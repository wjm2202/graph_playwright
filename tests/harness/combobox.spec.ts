/**
 * Combobox component object vs SLDS-blueprint-shaped markup:
 * role=combobox trigger, role=listbox popup, role=option items (founding doc §7).
 */
import { test, expect } from '@playwright/test';
import { Combobox } from '../../src/components/Combobox';

const COMBOBOX_PAGE = `
  <span id="stage-label">Stage</span>
  <button role="combobox" aria-labelledby="stage-label" aria-expanded="false"
          aria-haspopup="listbox" id="trigger">Select an Option</button>
  <ul role="listbox" hidden id="listbox">
    <li role="option" tabindex="0">Prospecting</li>
    <li role="option" tabindex="0">Negotiation</li>
    <li role="option" tabindex="0">Closed Won</li>
  </ul>
  <script>
    const trigger = document.getElementById('trigger');
    const listbox = document.getElementById('listbox');
    trigger.addEventListener('click', () => {
      // Simulate Lightning's async popup render
      setTimeout(() => {
        listbox.hidden = !listbox.hidden;
        trigger.setAttribute('aria-expanded', String(!listbox.hidden));
      }, 150);
    });
    listbox.addEventListener('click', (e) => {
      const opt = e.target.closest('[role="option"]');
      if (!opt) return;
      trigger.textContent = opt.textContent;
      listbox.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
  </script>
`;

test('select() opens the listbox and picks by option text (auto-wait absorbs render delay)', async ({ page }) => {
  await page.setContent(COMBOBOX_PAGE);
  const stage = new Combobox(page, 'Stage');

  await stage.select('Closed Won');
  await stage.expectValue('Closed Won');
});

test('select() is exact-match — no accidental prefix hits', async ({ page }) => {
  await page.setContent(COMBOBOX_PAGE.replace('>Closed Won<', '>Closed<').replace('>Negotiation<', '>Closed Won<'));
  const stage = new Combobox(page, 'Stage');

  await stage.select('Closed Won');
  await stage.expectValue('Closed Won');
  await expect(page.getByRole('combobox')).not.toHaveText('Closed');
});
