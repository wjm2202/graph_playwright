# Real-org setup — from zero to a green multi-persona smoke test

Every command below tells you **why** it runs, **where** to run it, and **whether
it's safe**. Nothing here touches production: everything targets a **sandbox**.

## 0. Ground rules (from the research corpus, already encoded in memory)

- **Sandbox only.** Never point `.env` at production.
- Test users must **NOT** have the "API Only User" permission (Spring '26 blocks
  UI bridging for them).
- Give test users the **"Waive Multi-Factor Authentication for Exempt Users"**
  permission (that's the sanctioned automation exemption — the similarly named
  "MFA for User Interface Logins" checkbox is NOT it).
- Add your machine's/CI's IP to **Setup → Network Access → Trusted IP Ranges**
  so headless logins skip "Verify Your Identity" email challenges.
- Pin each test user's **locale + timezone** (expected values derive from them).

## 1. Create the test users (once, in the sandbox, ~10 min)

Where: Salesforce **Setup → Users** in your sandbox. Why: one user per persona —
`admin` (System Administrator), `sales_user` (Standard User), optionally a
portal user for Experience Cloud. Safe: creating users in a sandbox has no
production impact.

Apply the ground rules above to each user (MFA waiver, not API-only, locale).

## 2. Authenticate the Salesforce CLI (once per machine)

Where: **your Mac's terminal** (any directory). Why: the CLI mints the access
tokens the test suite injects — no passwords ever land in Playwright. Safe: the
browser window it opens is Salesforce's own login; the CLI stores the auth
locally on your machine.

```bash
sf org login web --instance-url https://test.salesforce.com --alias my-sandbox
```

(Log in as the **admin test user** when the browser opens. Repeat with
`--alias sales-sandbox` logged in as the sales user, if you want per-persona
tokens now — or start admin-only.)

## 3. Fill .env (once, then whenever tokens rotate)

Where: `salesforce_playwright/.env` (copy `.env.example`; it's gitignored —
verify with `git status` if in doubt). Why: personas.json maps personas to these
env names; the validator refuses inline secrets anywhere else. Safe: local file,
never committed, values only ever sent to your own org's domains.

```bash
sf org display --target-org my-sandbox --json
```

From the output copy `accessToken` → `SF_ADMIN_TOKEN` and `instanceUrl` →
`SF_INSTANCE_URL`. Same per persona (`SF_SALES_TOKEN`, …), or use
username+password fallbacks (`SF_SALES_USERNAME`/`SF_SALES_PASSWORD`) — the
auth ladder handles either. Portal testing additionally needs `SF_SITE_URL` and
`SF_PORTAL_*`.

Note: CLI access tokens **expire with the org session** (hours). When e2e runs
start failing auth, re-run `sf org display` and paste the fresh token, or delete
`.auth/*.json` to force a re-login. Long-lived setups use JWT auth later.

## 4. Run the smoke (every time)

Where: `salesforce_playwright/` on your Mac. Why: proves login→session→LEX for
every configured persona, and that two personas hold live sessions at once —
the foundation every journey builds on. Safe: read-only against the org (it
opens the home page; creates nothing).

```bash
npm run test:e2e -- tests/e2e/multi-persona-smoke.spec.ts
```

Expected: each configured persona's test passes; unconfigured personas **skip
with the exact env var named**. First run per persona does one real login and
writes `.auth/<persona>.json`; subsequent runs attach in ~100ms.

## 5. Run the reference journey (when step catalog lands for your org)

`journeys/expense_approval_sod.json` is the shipped segregation-of-duties
reference. Its step-catalog entries (`expense.submit/approve/verify`) bind to
YOUR org's actual objects — that wiring session is the next piece of real-org
work, and recording (design doc §7) will generate most of it.

## Troubleshooting

- **singleaccess 403 / portal login fails** → check the user isn't API-only,
  token has web/full scope, and you POSTed to the SITE domain (the code does).
- **"Verify Your Identity" page** → Trusted IP Ranges (step 0).
- **MFA prompt in headless run** → the waiver permission is missing (step 0).
- **Blank portal page** → the four-suspects diagnostic, in order: unpublished
  changes → CDN/browser cache → guest/persona object permissions → sharing
  rules. (Encoded in memory: `v1.procedure.portal_blank__four_suspects`.)
