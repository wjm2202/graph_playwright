/**
 * Datatable component object vs SLDS data-table-shaped markup:
 * rows by accessible text, cells by the stable data-label attribute
 * (founding doc §7).
 */
import { test } from '@playwright/test';
import { Datatable } from '../../src/components/Datatable';

const TABLE_PAGE = `
  <table class="slds-table">
    <thead>
      <tr><th scope="col">Name</th><th scope="col">Amount</th><th scope="col">Stage</th></tr>
    </thead>
    <tbody>
      <tr><td data-label="Name">Acme Renewal</td><td data-label="Amount">$50,000</td><td data-label="Stage">Negotiation</td></tr>
      <tr><td data-label="Name">Globex New Biz</td><td data-label="Amount">$120,000</td><td data-label="Stage">Prospecting</td></tr>
      <tr><td data-label="Name">Initech Upsell</td><td data-label="Amount">$9,500</td><td data-label="Stage">Closed Won</td></tr>
    </tbody>
  </table>
`;

test('cell targeting by row text + column data-label', async ({ page }) => {
  await page.setContent(TABLE_PAGE);
  const table = new Datatable(page);

  await table.expectCell(/Acme/, 'Amount', '$50,000');
  await table.expectCell(/Globex/, 'Stage', 'Prospecting');
});

test('row count excludes the header row', async ({ page }) => {
  await page.setContent(TABLE_PAGE);
  const table = new Datatable(page);

  await table.expectRowCount(3);
});

test('waits for late-rendered rows (Lightning re-render simulation)', async ({ page }) => {
  await page.setContent(`
    <table><tbody id="body"></tbody></table>
    <script>
      setTimeout(() => {
        document.getElementById('body').innerHTML =
          '<tr><td data-label="Name">Late Row</td></tr>';
      }, 300);
    </script>
  `);
  const table = new Datatable(page);

  await table.expectCell(/Late Row/, 'Name', 'Late Row');
});
