/**
 * R2 fixture generator — env-gated (GEN_FIXTURE=1), run deliberately whenever
 * the Playwright version bumps, then COMMIT the regenerated fixture:
 *
 *   GEN_FIXTURE=1 npx playwright test tests/record/make-fixture-trace.spec.ts --project=record
 *
 * Produces tests/fixtures/trace-demo/trace.zip: a tiny scripted "journey"
 * against local markup with a mocked /aura endpoint, exercising exactly the
 * event kinds the trace reader must parse — actions (click/fill), a
 * navigation, and network in the aura family.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test('generate the committed fixture trace', async ({ browser }) => {
  test.skip(!process.env.GEN_FIXTURE, 'fixture generator — run with GEN_FIXTURE=1 on purpose');

  const dir = path.join('tests', 'fixtures', 'trace-demo');
  fs.mkdirSync(dir, { recursive: true });

  const context = await browser.newContext();
  await context.tracing.start({ snapshots: true, screenshots: false });
  const page = await context.newPage();

  const pageHtml = `
    <main>
      <h1>Fixture Journey</h1>
      <label for="amount">Amount</label><input id="amount" type="text" />
      <div role="combobox" aria-label="Stage" aria-expanded="false" tabindex="0">Stage</div>
      <ul role="listbox"><li role="option" tabindex="0">Closed Won</li></ul>
      <button id="save">Save</button>
      <script>
        document.getElementById('save').addEventListener('click', () => {
          fetch('/aura?r=1', { method: 'POST', body: 'message=fixture' });
        });
      </script>
    </main>`;

  await page.route('**/aura*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ actions: [{ id: '1', state: 'SUCCESS', returnValue: { id: '001FIXTURE0000001' } }] }),
    }),
  );
  await page.route('**/lightning/**', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml }),
  );

  // A real navigation (LEX-shaped URL) gives the page an origin for the
  // relative /aura fetch AND gives the trace reader a nav event to parse.
  await page.goto('https://fixture.test/lightning/r/Account/001FIXTURE0000001/view');

  await page.getByLabel('Amount').fill('4999');
  await page.getByRole('combobox', { name: 'Stage' }).click();
  await page.getByRole('option', { name: 'Closed Won' }).click();
  const auraDone = page.waitForResponse((r) => r.url().includes('/aura'));
  await page.getByRole('button', { name: 'Save' }).click();
  await auraDone;

  await context.tracing.stop({ path: path.join(dir, 'trace.zip') });
  await context.close();
   
  console.log(`fixture written: ${path.join(dir, 'trace.zip')}`);
});
