/**
 * G1 GATE (sprint S-REC, pre-registered): a recording distilled by the
 * pipeline runs through the REAL runner with ZERO hand edits to the journey
 * JSON — journeys/fixture_demo.generated.json and its generated step
 * implementations are executed VERBATIM as committed by the generator.
 *
 * The page served here is the same markup the recording was made against
 * (mocked /aura included), so this proves the loop: human drives → trace →
 * distill → generate → runner replays. Baselines are deliberately NOT passed:
 * one sandbox sample is not history, and G1 measures executability, not drift
 * (grading semantics are unit-covered in baselines.spec/journeys.spec).
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import { StepCatalog } from '../../src/journeys/catalog';
import { runJourney } from '../../src/journeys/runner';
import type { Journey } from '../../src/journeys/schema';
import { registerSteps_fixture_demo } from '../../src/journeys/generated/fixture_demo.steps';

 
const journey = require(path.resolve(__dirname, '../../journeys/fixture_demo.generated.json')) as Journey;

const PAGE_HTML = `
  <main>
    <h1>Fixture Journey</h1>
    <label for="amount">Amount</label><input id="amount" type="text" />
    <div role="combobox" aria-label="Stage" aria-expanded="false" tabindex="0">Stage</div>
    <ul role="listbox"><li role="option" tabindex="0">Closed Won</li></ul>
    <button id="save">Save</button>
    <script>
      document.getElementById('save').addEventListener('click', () => {
        fetch('/aura?r=1', { method: 'POST', body: 'message=replay' });
      });
    </script>
  </main>`;

test('G1: the generated journey replays through the real runner, zero JSON edits', async ({ browser }) => {
  const auraCalls: string[] = [];

  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc({
      org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
      personas: { sales_user: { kind: 'internal', usernameEnv: 'SF_SALES_USERNAME' } },
    }),
    authenticator: async (_persona, b) => {
      const context = await b.newContext({ baseURL: 'https://fixture.test' });
      await context.route('**/aura*', (route) => {
        auraCalls.push(route.request().url());
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ actions: [{ id: '1', state: 'SUCCESS' }] }),
        });
      });
      await context.route('**/lightning/**', (route) =>
        route.fulfill({ status: 200, contentType: 'text/html', body: PAGE_HTML }),
      );
      return context;
    },
  });

  try {
    const catalog = registerSteps_fixture_demo(new StepCatalog());
    const report = await runJourney(journey, {
      cast,
      catalog,
      personaIds: ['sales_user'],
    });

    // The runner replayed every recorded step, in order, green:
    expect(report.steps.map((s) => `${s.kind}:${s.name}:${s.status}`)).toEqual([
      'do:recordPage.open:ok',
      'do:form.fill:ok',
      'do:combobox.select:ok',
      'do:modal.save:ok',
    ]);
    expect(report.flags).toEqual([]);

    // And the replay really exercised the page: value filled, settle burst fired.
    const page = await cast.as('sales_user');
    await expect(page.getByLabel('Amount')).toHaveValue('4999');
    expect(auraCalls).toHaveLength(1);
    expect(auraCalls[0]).toContain('/aura');
  } finally {
    await cast.releaseAll();
  }
});
