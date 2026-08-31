import { defineConfig } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

/**
 * Three projects, three purposes (see L2/FOUNDING-DOCUMENT.md §9):
 *  - unit:    pure-TS tests of helpers. No browser. Always runnable.
 *  - harness: component objects validated against SLDS-shaped local markup
 *             (incl. open shadow DOM) via page.setContent(). Browser, no org.
 *  - e2e:     real-org journeys. Env-gated: skips cleanly without SF_* vars.
 *
 * networkidle is never used anywhere in this repo — LEX never reaches
 * network quiescence (founding doc §3.4). Web-first assertions only.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  expect: { timeout: 10_000 },
  use: {
    trace: 'on-first-retry',
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: 'unit',
      testMatch: /unit\/.*\.spec\.ts/,
    },
    {
      name: 'harness',
      testMatch: /harness\/.*\.spec\.ts/,
    },
    {
      // Human-driven recording sessions (sprint S-REC R1). Headed, env-gated,
      // no timeout — the human closes the page to finish. Never part of CI.
      name: 'record',
      testMatch: /record\/.*\.spec\.ts/,
      timeout: 0,
    },
    {
      name: 'e2e',
      testMatch: /e2e\/.*\.spec\.ts/,
      use: {
        baseURL: process.env.SF_INSTANCE_URL,
        // Trust the founding doc §6: generous expect timeouts absorb
        // Lightning's variable rendering; no fixed sleeps.
      },
    },
  ],
});
