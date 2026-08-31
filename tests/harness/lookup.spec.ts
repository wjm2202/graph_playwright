/**
 * Lookup/typeahead component object: type → async listbox population →
 * option click (founding doc §7). The 200ms delay simulates the search XHR.
 */
import { test, expect } from '@playwright/test';
import { Lookup, escapeRegex } from '../../src/components/Lookup';

const LOOKUP_PAGE = `
  <label for="acct">Account Name</label>
  <input id="acct" role="combobox" aria-expanded="false" aria-haspopup="listbox" />
  <ul role="listbox" hidden id="results"></ul>
  <script>
    const input = document.getElementById('acct');
    const results = document.getElementById('results');
    const DATA = ['Acme Corp', 'Acme Subsidiary', 'Globex'];
    input.addEventListener('input', () => {
      setTimeout(() => {  // simulate async search round-trip
        const q = input.value.toLowerCase();
        results.innerHTML = DATA.filter(d => d.toLowerCase().includes(q))
          .map(d => '<li role="option" tabindex="0">' + d + '</li>').join('');
        results.hidden = results.children.length === 0;
      }, 200);
    });
    results.addEventListener('click', (e) => {
      const opt = e.target.closest('[role="option"]');
      if (!opt) return;
      input.value = opt.textContent;
      results.hidden = true;
    });
  </script>
`;

test('search() waits for async results and selects the match', async ({ page }) => {
  await page.setContent(LOOKUP_PAGE);
  const lookup = new Lookup(page, 'Account Name');

  await lookup.search('acme', 'Acme Corp');
  await expect(lookup.input).toHaveValue('Acme Corp');
});

test('search() defaults the option match to the query text (case-insensitive)', async ({ page }) => {
  await page.setContent(LOOKUP_PAGE);
  const lookup = new Lookup(page, 'Account Name');

  await lookup.search('Globex');
  await expect(lookup.input).toHaveValue('Globex');
});

test('escapeRegex neutralises special characters in queries', () => {
  const re = new RegExp(escapeRegex('A+B (Ltd.)'), 'i');
  expect(re.test('a+b (ltd.)')).toBe(true);
  expect(re.test('AxB (Ltd?)')).toBe(false);
});
