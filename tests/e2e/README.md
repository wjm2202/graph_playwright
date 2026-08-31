# e2e tests

Env-gated: without `SF_*` variables in `.env` these skip and `npm test` stays green.

To run against a real org (sandbox — never production):

1. `sf org display --json` → copy `accessToken` + `instanceUrl` into `.env`.
2. `npm run test:e2e`

Notes from the founding document that bite here first:

- The test user must NOT be an API-only user (Spring '26 blocks UI bridging).
- Access tokens expire with the org session — regenerate via `sf org display` when runs start failing at the frontdoor step.
- For suites (not this single example), promote auth into a setup project writing storageState per persona (`src/auth/storage.ts` has the path conventions), and one test user per parallel worker.
- The edit test assumes a standard record-page Edit button/modal; adjust labels to your org's layout — org shape determines the DOM.
