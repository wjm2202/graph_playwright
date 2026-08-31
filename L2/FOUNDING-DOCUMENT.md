# Salesforce Lightning + Experience Cloud Testing with Playwright/TypeScript
## Research corpus for L2 substrate design — 2026-08-30

Purpose: source material for designing an atom schema (step 2) and populating an L2 memory substrate about Salesforce Playwright test architecture, engineering, patterns, and techniques.

Confidence markers used throughout: **[V-O]** verified against official docs (Salesforce/Playwright/npm), **[V-M]** corroborated by 2+ independent sources, **[S]** single practitioner source, **[INF]** inference from documented facts.

Atomization hints: each `###` block is roughly one knowledge cluster; bullets are written as discrete standalone claims so each can become one atom. Sections 13–14 flag volatile facts (candidate `state` atoms) vs durable facts.

---

## 1. Executive summary

Salesforce Lightning is a metadata-driven SPA whose DOM is generated, release-churned, and (currently) synthetic-shadow encapsulated. Successful Playwright testing rests on five pillars:

1. **Auth by token injection, never per-test UI login** — `sf` CLI / OAuth token → frontdooor.jsp or UI Bridge `singleaccess` → storageState reuse, one state per persona per domain.
2. **Semantic locators** — role/label/text (SLDS is ARIA-compliant, Playwright pierces open shadow DOM); never generated IDs, never XPath (doesn't pierce shadow roots), never deep structural CSS.
3. **Condition-based waiting** — web-first auto-retrying assertions on app-visible state (spinners gone, toast shown, dialog hidden); never `networkidle`, never `waitForTimeout`.
4. **Data via API, UI for behavior only** — jsforce v3 / REST / Composite Tree for setup+teardown, deep-link to records, unique-per-run naming, per-worker test users.
5. **Thin owned architecture** — class-based POM + component objects for Lightning base components, composed via Playwright fixtures. No dominant off-the-shelf framework exists (UTAM ≠ Playwright); teams roll their own layer.

The dominant risk horizon: Salesforce's synthetic→native shadow DOM migration, SLDS 2 theming, 3 seasonal releases/year churning component internals, and frontdoor `sid=` deprecation pressure.

---

## 2. Language of the application (glossary — candidate fact/hub atoms)

### 2.1 Platform vocabulary
- **Org** — one customer's Salesforce instance (data + metadata + users). Tests always target a specific org; org shape determines the DOM. **[V-O]**
- **Production / Sandbox / Scratch org** — live org; refreshable copy; ephemeral CLI-created org. UI automation normally targets sandboxes or dedicated test orgs. Preview sandboxes receive the next seasonal release ~4–5 weeks early. **[V-O]**
- **Lightning Experience (LEX)** — the modern SPA UI, built on the Aura framework with LWC and Aura components coexisting. **Salesforce Classic** is the legacy server-rendered UI, still underlying some iframed Setup screens. **[V-O]**
- **LWC (Lightning Web Components)** — modern standard-based component framework; renders into shadow trees (synthetic today, native incoming). **Aura components** — legacy framework; render into plain light DOM, no shadow roots. **[V-O]**
- **Base components** — the `lightning-*` namespace shipped by Salesforce (input, combobox, datatable, button, spinner…); each implements an SLDS blueprint. **[V-O]**
- **SLDS** — Salesforce Lightning Design System; defines blueprint HTML/CSS (`slds-*` classes, ARIA roles). **SLDS 2** ("Cosmos" theme) GA in Winter '26; same class names, different computed styles + dark mode → visual baselines are theme-dependent. **[V-M]**
- **Object / Record / Field** — table / row / column. Custom ones suffixed `__c`. Field **API names** are the stable identifiers behind translatable labels. **[V-O]**
- **Record page, FlexiPage, Lightning App Builder** — record pages are FlexiPages (component layouts) configured per org/app/profile/record type; the same object can render different components per user. Major cause of cross-org test drift. **[V-O]**
- **Page layout / Compact layout / Dynamic Forms** — field arrangements; Dynamic Forms places fields as individual FlexiPage components, changing record-detail DOM vs classic Record Detail. **[V-O]**
- **Highlights panel** — top-of-record summary strip (compact layout fields + actions). **Related list** — child-record component. **Path** — chevron stage bar with "Mark Stage as Complete". **Utility bar** — docked footer panels that can overlay/intercept clicks. **[V-O]**
- **Quick action / Global action** — configured buttons launching create/edit/flow/LWC modals; most create/edit flows tests exercise are quick actions opening `role="dialog"` modals. **[V-O]**
- **Setup / Object Manager** — admin area (`/lightning/setup/...`); many Setup screens are Classic pages inside iframes. **[V-O]**
- **List view** — saved filterable table at `/lightning/o/<Object>/list?filterName=...`; rewritten as LWC in Summer '25. **[V-O]**
- **Profile / Permission set** — determine which tabs/objects/fields/buttons *exist in the DOM* for the test user. Locator failures are frequently permissions, not selectors. **[V-M]**
- **Record type / Picklist / Lookup** — per-object variant driving layouts + picklist values; picklist renders as `lightning-combobox`; lookup renders as combobox-style search with async listbox. **[V-O]**
- **Visualforce** — legacy page framework; appears inside LEX as cross-origin iframes with classic stable-id DOM. **[V-M]**
- **Release cadence** — three seasonal releases/year (Spring ~Feb, Summer ~Jun, Winter ~Oct) + patches; each can change component internals without notice. **[V-O]**

### 2.2 Experience Cloud (portal) vocabulary
- **Experience Cloud site** ("community", "portal") — externally-facing site built on one of three frameworks: **Salesforce Tabs + Visualforce** (classic), **Aura templates** (Customer Service, Partner Central, Help Center, Customer Account Portal, Build Your Own), **LWR templates** (Build Your Own (LWR), Microsite (LWR)). **[V-O]**
- **Aura sites** — server-rendered per request; LWC runs with synthetic shadow; pages under `/s/` path; data via `…/s/sfsites/aura` XHR endpoint. **[V-M]**
- **LWR (Lightning Web Runtime) sites** — pre-compiled at publish into static CDN-cached snapshots; native shadow DOM (can be fully light DOM); no `/s/` segment by default; ~50% faster; every LWC change requires republish. **[V-M]**
- **Experience Builder** — the site editor; changes are NOT live until **published** (deploys don't publish either). **[V-M]**
- **Guest user** — unauthenticated visitor, backed by a **guest user profile**; zero record access by default (secure guest access); record access only via dedicated guest sharing rules; missing permissions cause *silently empty* components, not errors. **[V-O]**
- **External licenses** — Customer Community (no roles/sharing rules; sharing sets only), Customer Community Plus (roles ≤3/account, sharing rules, reports), Partner Community (adds leads/opportunities/PRM), External Apps, External Identity, Channel Account. Member-based vs login-based pricing affects test-account economics. **[V-O]**
- **Sharing set** — grants high-volume external users access to records whose Account/Contact lookup matches the user's; not available to guests. **[V-O]**
- **Audience targeting (Aura) / visibility rules + component variations (LWR)** — same page renders different components per persona; a direct assertion target. **[V-M]**
- **Enhanced domains** — all sites on `https://<mydomain>.my.site.com` (enforced Winter '24); portal session cookies are domain-scoped, separate from org (`*.my.salesforce.com` / `*.lightning.force.com`) sessions. **[V-O]**

### 2.3 Playwright vocabulary (the testing-framework language)
- **Locator** — lazy, re-resolved-at-action-time element query; immune to Lightning re-renders that break stored element handles. **[V-O]**
- **Web-first assertion** — `await expect(locator).toBeVisible()` etc.; auto-retries until pass/timeout; the primary anti-flake tool. **[V-O]**
- **Strict mode** — locator resolving to >1 element throws; drives the "scope to container" discipline Salesforce's repeated labels require. **[V-O]**
- **storageState** — JSON snapshot of cookies+localStorage; the session-reuse mechanism. **[V-O]**
- **Fixture** — `test.extend` dependency injection; scopes: test / worker. Worker-scoped auth fixtures keyed on `testInfo.parallelIndex` = one user per worker. **[V-O]**
- **Project / project dependencies** — config-level groupings; the "setup project logs in, other projects depend on it" auth pattern. **[V-O]**
- **frameLocator** — auto-waiting iframe traversal (for Visualforce frames). **[V-O]**
- **APIRequestContext** — Playwright's built-in HTTP client, usable for Salesforce REST auth+data. **[V-O]**
- **Trace viewer** — DOM snapshots + network + console per action; "the single most valuable debugging tool for Salesforce" (shows which XHR was pending when an assertion failed). **[V-O mechanism / S quote]**
- **Sharding / blob reports** — `--shard=i/n` across CI machines, `merge-reports` at the end. **[V-O]**

---

## 3. Platform internals that drive test behavior (fact atoms)

### 3.1 Shadow DOM state of the world (as of Aug 2026)
- LEX and Experience Builder (Aura) sites use **synthetic shadow DOM by default** — a polyfill (`@lwc/synthetic-shadow`); "shadow" content actually lives in the main document with obfuscated scope attributes (`lwc-…-host`). Never select on scope attributes. **[V-O]**
- **Mixed shadow mode** (opt-in native shadow via `static shadowSupportMode = 'native'`) is still **Beta**; base `lightning-*` components are **not yet supported** in native mode — a stock org renders base components in synthetic shadow. **[V-O]**
- **LWR sites use native shadow DOM** (and can use light DOM, `lwc:render-mode="light"`, reachable by plain `querySelector`). **[V-O]**
- Playwright: **all locators pierce open shadow roots by default; XPath does NOT pierce shadow roots; closed shadow roots are unsupported**. **[V-O]**
- Because synthetic shadow is really light DOM, XPath *happens to work* on LEX today; the moment a subtree flips native, the same XPath silently stops matching. XPath suites are doubly doomed. **[V-O + INF]**
- `css:light` engine restricts a query to light DOM when piercing is undesirable. **[V-O]**
- Salesforce began changing base-component internals for native-shadow readiness in Summer '23 (e.g., new wrapper `div[part]` inside the boundary): "Any implementation that uses CSS combinators will fail." **[V-O]**

### 3.2 Why IDs and structure are unusable
- Aura components have runtime-unique `globalId`s baked into DOM ids (`id="940:1376;a"`), regenerated per render — official docs say never rely on them. **[V-O]**
- Lightning auto-generates element IDs (`input-42`, `combobox-button-171`) that change every render. **[V-M]**
- In native shadow, element IDs are scoped per component — document-unique-id selection is architecturally impossible. **[V-O]**
- Official Salesforce position: component markup may change every release; official Playwright position: structural CSS/XPath selectors are brittle by design. **[V-O]**
- Practitioner audits report ~20–30% selector breakage per seasonal release in structure-coupled suites. **[S]**

### 3.3 Security architecture (Locker / LWS)
- **Lightning Web Security (LWS)** replaced Lightning Locker: per-namespace JS sandboxes with "distortions" of native APIs. Default in orgs created Winter '23+; GA everywhere since Summer '23; **automatic enablement of older orgs was postponed** → 2026 fleet is mixed; the org's LWS toggle is a test-environment variable worth pinning. **[V-O]**
- LWS enforces `shadowRoot.mode === 'closed'` *as seen by in-sandbox component code* (Spring '24). Playwright's locator engine runs outside the sandboxes via CDP and continues to pierce LEX shadow trees normally. **[V-O + V-M]**
- Locker/LWS constrain *component code*, not the automation driver — but `page.evaluate()` runs in the page's main world where polyfill patches and platform globals live; results may differ from what locators see. Keep in-page JS minimal; prefer locators and network assertions. **[INF, grounded]**
- On LWR, don't attempt shadow-bypass CSS tricks like `:host-context()` — LWS blocks them. **[S]**

### 3.4 Network model
- Aura batches server actions via **boxcar'ing**: one POST to `/aura` (Experience sites: `/s/sfsites/aura`, variants `/aura`, `/sfsites/aura`, optionally behind a custom site prefix) multiplexing many actions; body is form-encoded with a JSON `message` envelope — batched and effectively opaque. **[V-O]**
- Salesforce's performance program is actively changing the network shape (HTTP/2, boxcar disablement for component delivery, preloading) — request-pattern-keyed waits are fragile release-over-release. **[V-O]**
- Hidden-tab components still issue requests; telemetry beacons run continuously — **LEX never reliably reaches network quiescence**. **[V-O]**

### 3.5 Iframes
- Visualforce embedded in LEX = cross-origin iframe (VF domain); inside is classic DOM with stable developer-authored ids. Use `frameLocator('iframe[title*="…"]')` / `iframe[name^="vfFrameId"]`. **[V-M]**
- Also iframed: some Classic Setup screens, email template previews, dashboards, Lightning Out 2.0 embeds (iframe + shadow + postMessage), Lightning Container (`lightning:container`). **[V-O/V-M]**

---

## 4. Authentication patterns (procedure atoms — highest-value cluster)

### 4.1 Recommended hierarchy
1. **Token injection** (frontdoor / UI Bridge) — fastest, no MFA, no login-form flake. **[V-M]**
2. **UI login once in a setup project + storageState reuse** — universal fallback. **[V-M]**
3. **Per-test UI login** — last resort; reserve for testing the login experience itself. **[V-M]**

### 4.2 Token injection mechanics
- Classic frontdoor: `https://<instance>/secur/frontdoor.jsp?sid=<accessToken>&retURL=<relative>`; token must be an OAuth access token with `web`/`full` scope, a SOAP login session, or Apex `UserInfo.getSessionId()`. Still documented as working (May 2026), but Salesforce recommends the single-use replacement for new implementations. **[V-O]**
- **UI Bridge API (the modern path)**: POST `access_token` to `/services/oauth2/singleaccess` on the org's My Domain **or on the Experience Cloud site domain** → returns `{"frontdoor_uri": "...frontdoor.jsp?otp=..."}`. URL valid ≤1 minute, usable exactly once. Not supported on login/test.salesforce.com. User must NOT have "API Only User". **[V-O]**
- CLI flow: `sf org display --json` → `accessToken` + `instanceUrl`. Since Aug 2025, `sf org open --url-only` URLs are **single-use and expire in 60s** — consume immediately in setup, persist the session via storageState; cannot cache/share the URL across workers. **[V-O]**
- Spring '26: API-only users can no longer bridge into UI sessions via frontdoor — the UI test user must not be an API-only integration user. **[V-M]**
- Experience Cloud caveat: community-user API session IDs are not reliably accepted by classic frontdoor (SAML SSO historically recommended); UI Bridge on the site domain is the clean programmatic portal login. Magic links (passwordless) are an alternative channel. **[V-O/V-M]**

### 4.3 storageState discipline
- Log in once (globalSetup or a `setup` project with `dependencies`), save `context.storageState({ path })`, reference from `use.storageState`. **[V-O]**
- **One storageState per persona per domain** — Salesforce sid cookies are domain-scoped (org domain vs `*.my.site.com` are separate sessions; two sid cookies: main + content domain). **[V-O + INF]**
- Guest project runs with empty storage state: `storageState: { cookies: [], origins: [] }`. **[V-M]**
- Sessions expire: set generous session timeout on test users; validate/refresh state when a run may outlive it. **[V-M]**
- Parallel workers mutating server state → **one test user per worker**, worker-scoped storageState fixture keyed on `testInfo.parallelIndex`. **[V-O]**

```ts
// worker-scoped auth (adapted from playwright.dev/docs/auth)
export const test = base.extend<{}, { workerStorageState: string }>({
  storageState: ({ workerStorageState }, use) => use(workerStorageState),
  workerStorageState: [async ({ browser }, use) => {
    const id = test.info().parallelIndex;            // stable worker slot
    const fileName = `.auth/worker-${id}.json`;
    // login as user #id via frontdoor, then context.storageState({ path: fileName })
    await use(fileName);
  }, { scope: 'worker' }],
});
```

### 4.4 MFA / identity verification for test users
- Sanctioned MFA exemption: **"Waive Multi-Factor Authentication for Exempt Users"** permission (Salesforce explicitly lists test-automation accounts as an exempt use case). Behavior subject to change as enforcement evolves — re-verify each release. **[V-O]**
- Naming trap: "Multi-Factor Authentication for User Interface Logins" is the per-user opt-IN switch, not an exemption — removing it does not waive MFA. **[V-O]**
- "Verify Your Identity" email challenges fire from untrusted IPs → add CI runner IPs to Trusted IP Ranges (Setup → Network Access) / profile login IP ranges. **[V-O]**

### 4.5 CI org auth (headless, for data/metadata, not browser)
- **JWT bearer flow**: `sf org login jwt --client-id --jwt-key-file --username --instance-url` (connected app + cert; Salesforce-recommended for CI). **[V-M]**
- **sfdxAuthUrl**: `sf org login sfdx-url` with the `sfdxAuthUrl` from `sf org display --verbose --json` stored as CI secret (no connected app). **[V-M]**
- Use `sf` v2 commands; `sfdx` is unmaintained since 2023. **[V-M]**

---

## 5. Locator strategy (procedure + constraint atoms)

### 5.1 Stability ranking (most → least stable)
1. **`data-testid` / `data-*` on components you own** — survives releases; `getByTestId()`; attribute configurable via `testIdAttribute`. Not available on standard Salesforce UI (closed ecosystem). **[V-M]**
2. **Role + accessible name** — `getByRole('button', { name: 'Save' })`; SLDS is ARIA-compliant and Salesforce rarely changes accessible names (its own a11y compliance depends on them); role locators query the composed tree, surviving the synthetic→native flip. **[V-M]**
3. **Field/object API names in attributes** — `[field-name="Industry"]`, `[data-target-selection-name="sfdc.RecordField.Account.Name"]`, datatable `[data-label="…"]`; API names survive label renames/translations. **[S exact attrs / V-M principle]**
4. **Custom-element tag anchors** — `page.locator('lightning-combobox')`, `records-record-layout-item`, filtered by `hasText`; tag names are the component's public identity. **[V-M]**
5. **Label text** — `getByLabel('Amount')`; stable per-org, breaks under i18n/renames. **[V-O]**
6. **SLDS classes** — only as coarse *state* markers (`.slds-spinner`, `.slds-modal_open`, `.slds-notify_toast`); never as primary element identifiers (Summer '25 removed deprecated classes; SLDS 2 re-themes). **[V-M]**
7. **Never** — generated ids, LWC scope attributes, nth-child/positional, deep combinators into base-component internals, absolute XPath (also: XPath doesn't pierce shadow roots at all). **[V-O]**

### 5.2 Disciplines
- Scope to containers to satisfy strict mode — Salesforce repeats labels across regions: `page.getByRole('tabpanel', { name: 'Details' }).getByLabel('Phone')`; scope all modal interaction to `page.getByRole('dialog')`. **[V-O mechanism / S pattern]**
- Never store resolved element handles; locators re-resolve at action time — this is Playwright's structural advantage over Selenium's stale-element model on re-render-happy Lightning. **[V-O]**
- Define every locator in exactly one place (POM/component object) so release churn is a localized diff. **[V-M]**

```ts
// Good — semantic, shadow-piercing, release-resilient
page.getByRole('button', { name: 'New' });
page.getByLabel('Account Name');
page.getByRole('row', { name: /Acme/ }).locator('[data-label="Amount"]');
// Bad — dies on next render or next release
page.locator('#input-42');
page.locator('//div[3]/div/div[2]/span/input');
```

---

## 6. Waiting strategies (procedure atoms)

- **`networkidle` is discouraged by Playwright and structurally wrong for LEX** (boxcar gaps → false-ready; beacons/hidden-tab traffic → never-ready). Some practitioner guides still use it as a pragmatic first settle; the strict position replaces it entirely. **[V-O + V-M]**
- Primary tool: **auto-retrying web-first assertions on app-visible state**:
  - target content: `await expect(page.getByRole('heading', { name: recordName })).toBeVisible()`
  - spinners gone: `await expect(region.locator('.slds-spinner')).toHaveCount(0, { timeout: 30_000 })`
  - toast: `await expect(page.locator('.slds-notify_toast')).toContainText(/was (created|saved)/i)`
  - modal closed: `await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 })`
  **[V-M]**
- Surgical network wait: `page.waitForResponse(r => r.url().includes('/aura') && r.request().method() === 'POST')` (portals: `/sfsites\/aura/`). Set up the promise **before** triggering the action. Wait on status/URL, don't assert payloads (boxcar envelope is opaque, multiplexed). **[V-M]**
- **Toast timing**: platform toasts auto-dismiss at 4.8s (9.6s with link) — assert immediately after the action. **[V-O]**
- Ban `waitForTimeout`; every wait must name the condition it awaits. **[V-M]**
- LEX navigations are pushState transitions, not document loads — `waitForURL()` works; load-state events don't correspond to content readiness. **[INF]**
- Console apps: inactive workspace tabs have **no DOM** until activated (Summer '25 lazy-load) — wait for a unique element inside a newly activated tab. **[S]**
- Hydration risk (esp. LWR): element can exist before listeners attach → a click can be a silent no-op; wait for a real readiness indicator, not mere presence. **[V-M]**

---

## 7. Component interaction patterns (procedure atoms with code)

- **Combobox / picklist** (`lightning-combobox` — NOT a native `<select>`; `selectOption()` doesn't work): click `role=combobox` trigger → click `role=option`:
  ```ts
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option, exact: true }).click();
  ```
  Rendered DOM: trigger `role="combobox"` + `aria-expanded` + popup `[role="listbox"]` > `[role="option"]`. **[V-O blueprint / V-M pattern]**
- **Lookup / typeahead**: click combobox → `fill(searchText)` → async search populates listbox → click matching option (auto-wait handles the XHR). **[V-M]**
- **Modal**: scope everything to `getByRole('dialog')`; assert hidden after save. **[V-M]**
- **Datatable**: rows by `getByRole('row', { name: /text/ })`, cells by `[data-label="Column"]`; grid variants use `role="grid"`/`gridcell`. Datatable internals are under active performance rework — expect churn. **[V-O]**
- **Date picker**: `fill()` the input directly (locale-formatted), `Escape` to close the overlay — don't click through the calendar grid. **[S]**
- **File upload**: bypass drag-drop; `locator('input[type="file"]').setInputFiles(path)`; assert the "1 of 1 file uploaded" text. **[V-M mechanism]**
- **Rich text**: target `[contenteditable="true"]` inside `lightning-input-rich-text`. **[S]**
- **Tabs**: click `role=tab`, assert `role=tabpanel` visible before touching fields (inactive panels may not render). **[S]**
- **Visualforce iframe**: `page.frameLocator('iframe[title*="…"]')`; inside is classic DOM. **[V-M]**
- **Path stage completion**: click stage → "Mark as Complete" → assert toast → verify persisted `StageName` via SOQL. **[S]**
- **Inputs**: `lightning-input` hosts a native `<input>` in its (synthetic) shadow; `getByLabel()` resolves it. **[V-M]**

---

## 8. Experience Cloud portal testing (fact + procedure atoms)

### 8.1 Per-runtime differences that change the test approach
| Concern | Aura site | LWR site |
|---|---|---|
| Rendering | server-side per request | static snapshot, CDN, hydrate |
| Shadow DOM | synthetic | native (or light DOM) |
| URL | `/s/` paths | no `/s/` by default |
| Data XHR | `…/s/sfsites/aura` | webruntime endpoints |
| Change visibility | publish | publish required for **every** LWC change |
| Persona rendering | audience targeting (profile/perm/domain) | visibility rules (User/Contact/Account fields) + component variations |

All rows **[V-M]**. Playwright role/text/data-* locators work identically on both (open-shadow piercing covers synthetic and native alike). **[V-M]**

### 8.2 Portal auth per persona type
- **Guest**: no auth; pin publish + CDN state first. **[V-M]**
- **Internal admin (org side)**: `sf org open --url-only` frontdoor (single-use, 60s). **[V-O]**
- **External users (customer/partner)**: OAuth token → `/services/oauth2/singleaccess` **on the site domain** (official), or UI login form → storageState (universal fallback), or magic link. **[V-O/V-M]**
- Multi-persona config shape: `setup` project per role → `.auth/<role>.json` → one Playwright project per persona (`customer`, `partner`, `guest` with empty state) with `dependencies: ['setup']`. **[V-O pattern]**

### 8.3 The four suspects when a portal test "sees nothing" (ordered diagnostic)
1. **Unpublished changes** (deploy ≠ publish; LWR needs republish per LWC change).
2. **CDN/browser cache** ("Enable secure and persistent browser caching" + "CDN for Lightning Component framework" org settings serve stale LWC after successful deploys; fresh contexts fix the browser half, not the CDN edge).
3. **Guest/persona object permissions** (guest profile CRUD).
4. **Sharing rules / sharing sets** (record-level; sharing sets don't cover guests; sharing sets on child objects don't grant parent-account access).
All **[V-M]**; the ordering is a practitioner synthesis. **[S]**

### 8.4 Portal-specific facts
- Guest users see **silently empty** components (no error) when permissions/sharing are missing — assert *presence and absence* per persona; record visibility is the UI expression of the license/sharing model. **[V-M]**
- "Down for maintenance" page causes: inactive Site Guest User, exceeded limits, DNS, platform incident — assert against it explicitly so infra states don't masquerade as functional failures; Service Not Available page is brandable, don't assume default copy. **[V-O]**
- LWR limits: 500 routes max (keep <250); merge fields don't work in URLs; no generic record pages; Experience Delivery (Beta) discontinued Winter '27. **[V-M/S]**
- Salesforce CDN migrating to Cloudflare during 2026 — relevant to CI allowlists. **[S]**
- Self-registration: flow-driven registration pages; guest profile needs the flow in "Enabled Flow Access"; SalesforceLabs Configurable Self-Registration LWC is a common concrete test target. **[V-M]**
- Guest flows can't be flow-debugged as guest — must be published and tested for real → pushes guest journeys toward UI E2E. **[V-O]**
- Accessibility: `@axe-core/playwright` per persona (page composition differs per audience); automated checks catch ~half of WCAG issues. **[V-M]**

---

## 9. Test architecture (procedure + decision atoms)

### 9.1 Structure
- **Class-based POM** (Playwright-official baseline): `readonly Locator` fields in constructor, intent-level action methods. **[V-O]**
- **Fixtures for composition/injection, not inheritance**: `test.extend<{ accountPage: AccountPage }>` wires POMs into tests. **[V-M]**
- **Component objects (CPOM) for Lightning base components**: reusable wrappers accepting `Page` or scoping `Locator` for combobox, lookup, datatable, modal, toast, VF iframe — the specific recommendation for Lightning's awkward pieces. **[V-M]**
- Real-world evaluation (Salesforce project, 2025): plain POM + Playwright + TS chosen **over UTAM** (updates lag Salesforce releases, custom components still need manual JSON, longevity doubts) **and over AI agents**. **[S — direct practitioner report]**
- Repo layout: `tests/`, `pages/`, `utils/` (auth, test data), `config/` (per-env: sandbox/uat), `fixtures/`, `.env`, `playwright.config.ts`. **[S]**
- Screenplay alternative: Serenity/JS actively supports Playwright Test (3.41.x, Aug 2026). **[V-O]**

### 9.2 Test data engineering
- **The strongest consensus in the space**: create/query/clean data via API; use the UI only for the behavior under test; deep-link to `/lightning/r/<Object>/<Id>/view`. **[V-M]**
- **jsforce v3** (3.10.x): TS-native (drop `@types/jsforce`), Node ≥18, REST/SOQL/Bulk/Streaming/Metadata/Tooling, typed queries `conn.query<T>(soql)`; lighter `jsforce-node` build exists. **[V-O]**
- Alternative without jsforce: Playwright `APIRequestContext` → `/services/oauth2/token` (client-credentials or username-password grant) → `POST /services/data/vXX.X/sobjects/<SObject>`. **[V-M]**
- **Composite sObject Tree API**: whole parent-child graph (Account+Contacts+Opportunity) in one atomic API call, counts as one API call against limits — ideal scenario seeding. **[V-M]**
- Cleanup patterns (coexisting): delete-in-teardown by returned Id; **unique-per-run prefix + periodic API sweeper** (`E2E_<runid>_…`); disposable org. Under concurrency: shared fixtures create read-only data only; mutable data per-test/per-worker. **[V-M]**
- **Dual-layer assertion**: act in UI → assert persisted state via SOQL (catches silent save failures / validation-rule reverts a toast can't); optionally also intercept the UI's own REST save response (201, `success:true`). **[S, strongly endorsed]**
- Org-coupled config (record types, validation rules, picklist values, profile-conditional layouts) is a recognized failure vector — tests must run under the profile they claim to test, and expected values must derive from the test user's locale/timezone (SF stores UTC, renders per-user), not the CI clock. Pin test-user locale/timezone; test ICU locale formats when in play. **[V-M]**

### 9.3 Environments
- Scratch orgs: made for CI/CD but poor for realistic-data E2E (limits, slow creation, empty data). **Scratch Org Snapshots** (GA Summer '24) amortize setup. **[V-O/V-M]**
- Dominant practice: **persistent dedicated test sandbox** with API-seeded, per-worker-isolated data; scratch orgs for package/deployment validation. **[V-M, partially synthesized]**
- Keep one sandbox on **preview** each release cycle (~4–5 weeks early); run the suite on preview AND non-preview and **diff the failures** to separate release breakage from own regressions. **[V-O]**

### 9.4 CI
- Sharding: `--shard=i/n` via GH Actions matrix → blob reports → `merge-reports`. 2–4 workers per standard 2-vCPU runner. **[V-O/V-M]**
- Smoke on PR; full regression nightly; persist traces/videos/SF debug logs as artifacts. **[S]**
- `retries: CI ? 2 : 0`; `trace: 'on-first-retry'`; flaky list is a backlog, not noise; reproduce with `--repeat-each=20` (fix counts at 20/20). **[V-M/S]**
- Parallel against a shared org is safe only with per-worker users + unique record naming + no cross-test data reads; serial mode is legitimate when tests mutate shared org state. `fullyParallel` interacts surprisingly with serial suites — set mode deliberately. **[V-M]**

### 9.5 Test pyramid placement (what NOT to E2E)
- LWC JS logic → **Jest / sfdx-lwc-jest** (local, mocked wire adapters). **[V-O]**
- Server logic → **Apex tests** (deployment gate); don't re-prove via UI. **[V-M]**
- Flows → **Flow Builder tests** (limits: no screen flows, no async paths, no delete triggers, ≤200 tests/flow) → screen-flow journeys still need UI E2E. **[V-O]**
- Playwright E2E → **critical user journeys only**, chosen by business value + regression risk. **[V-M]**

---

## 10. Flake control (constraint atoms)

Root-cause → fix table (all **[V-M]** unless noted):
- Racing the render → web-first assertions + spinner waits.
- Toast raced past → assert immediately (4.8s window).
- Stale handles after re-render → never store handles; locators re-resolve.
- Data collisions → unique names, per-worker users, API cleanup.
- Session expiry mid-run → generous timeout + state validation/refresh.
- Login flake → token injection, never per-test UI login.
- Browser state is isolated per test (fresh context) — in Salesforce the isolation problem is **server-side org data**, not browser state. **[V-O]**
- WCAG 2.2 (Summer '25) made modals reflow at zoom — never click by coordinates. **[S]**

---

## 11. Ecosystem (fact atoms)

- **UTAM**: Salesforce's JSON page-object framework; JS runtime binds to **WebdriverIO only — no Playwright adapter exists**; docs moved to developer.salesforce.com; slow cadence (utam-java Jun 2025; `salesforce-pageobjects` npm v12, Jul 2026); practitioners question longevity and note page objects lag releases. **[V-O]**
- **No dominant open-source Playwright-Salesforce framework or npm helper library exists (Aug 2026)** — the field is guides + in-house layers. Notable negative finding; roll your own thin layer. **[V-M]**
- Repos worth studying: `salesforce/codeceptjs-bdd` (official; Playwright driver + LWC shadow support), `OliverAHolmes/salesforce-playwright` (scratch-org setup via frontdoor), `dawiddiwad/checkmate` (`@xoxoai/checkmate/salesforce`, Playwright 1.60 + AI fixture, active Aug 2026), `trailheadapps/ebikes-lwc` (canonical Experience Cloud sample; UTAM/WDIO E2E in-repo), `robocorp/salesforce-lightning-playwright-examples` (Python, locator ideas), `TestLeafInc/playwright-salesforce` (Java patterns), `sfdx-browserforce-plugin` (org-setup automation, Playwright-based since v6). **[V-O/V-M]**
- Commercial landscape (one-liners): Provar (metadata-driven, SF-native), Copado Robotic Testing (self-healing, Robot Framework), AccelQ (no-code AI), Testim/Tricentis (hybrid), TestZeus Hercules (OSS AI agent), ZeroStep (NL Playwright layer marketed at Salesforce). **[V-M]**
- Practitioner canon: himanshuai.substack.com 2026 complete guide (most-cited), cassandrahl.com POM-vs-UTAM report, testrigtechnologies.com setup guide, Vaikar jsforce guide, desplega.ai shadow-DOM deep dive, Gearset tooling comparison. **[V-M]**

---

## 12. Consolidated tips & anti-patterns (constraint/procedure atoms, atomize individually)

1. Never locate by generated IDs; role/label/text first. **[V-M]**
2. No XPath at all (brittle + doesn't pierce shadow roots). **[V-O]**
3. Ban `waitForTimeout`; wait on named conditions. **[V-M]**
4. Never create test data through the UI. **[V-M]**
5. Never hardcode record IDs — create or resolve per run. **[V-M]**
6. One dedicated test user per parallel worker. **[V-O]**
7. Run under the profile the test claims to test (role-based rendering). **[S]**
8. Pin test-user timezone/locale; compute expected values from them. **[V-M]**
9. Log in once, reuse the session (token/storageState) — the biggest speed/flake win. **[V-M]**
10. Secrets in vault/CI secrets; never hardcode credentials. **[S]**
11. Unique run-prefix on all created records + API sweeper. **[V-M]**
12. Assert both sides: UI state AND persisted API/SOQL state. **[S]**
13. Add a11y (`@axe-core/playwright`) and visual checks — releases change rendering without breaking function (mind SLDS 2 theme variance). **[S/V-M]**
14. Expect Visualforce iframes inside Lightning; use frameLocator. **[V-M]**
15. Locators live in exactly one place; budget maintenance for 3 releases/year. **[V-M]**
16. Toast assertions immediately after action. **[V-O]**
17. Scope locators to containers (dialog/tabpanel) for strict mode. **[V-M]**
18. On portals, run the same spec under every persona and assert presence AND absence. **[V-M]**
19. A locator failure is often a permissions/config failure — check profile/FlexiPage assignment before blaming the selector. **[V-M]**
20. Treat maintenance/SNA pages as first-class assertions. **[V-O]**

---

## 13. Volatile facts — candidate `state` atoms (re-verify each release)

- Base `lightning-*` components run in **synthetic shadow** (mixed shadow mode still Beta) — will flip via release note; instantly breaks XPath and raw-DOM assumptions. **[V-O, Aug 2026]**
- frontdoor `?sid=` still works; deprecation pressure via single-use UI Bridge; no dated retirement announced. **[V-O, May 2026 article]**
- LWS: default in new orgs; auto-enablement of older orgs postponed → mixed fleet; org toggle is an environment variable. **[V-O]**
- Boxcar disablement + HTTP/2 rollout changing `/aura` network signatures. **[V-O]**
- SLDS 2 GA Winter '26; theme/dark-mode variance for visual baselines. **[V-M]**
- Salesforce CDN → Cloudflare migration during 2026. **[S]**
- `sf org open` URLs single-use/60s since Aug 2025. **[V-O]**
- Playwright current ~1.6x; jsforce 3.10.x; Serenity/JS 3.41.x; UTAM npm v12. **[V-O, Aug 2026]**
- Experience Delivery (Beta) discontinued Winter '27. **[S]**

## 14. Durable invariants (high-confidence long-lived facts)

- Playwright locators pierce open shadow roots; XPath never does; closed roots unsupported.
- Aura renders light DOM; LWC renders shadow trees; light-DOM LWC opts out.
- Generated IDs are runtime-unique by design.
- SLDS blueprints are ARIA-compliant → role/name locators are the durable interface.
- Aura batches actions to `/aura`-family endpoints; payload envelope is opaque.
- Salesforce ships 3 seasonal releases/year and reserves the right to change component internals.
- Sessions are cookie-per-domain; portal and org sessions are distinct.
- Deploy ≠ publish on Experience Cloud.
- Guest access failures are silent (empty, not error).
- The testing pyramid holds: Jest/Apex/Flow tests below, Playwright for journeys only.

---

## 15. Atomization notes for step 2 (observations, not the design itself)

- Natural clusters observed: **glossary/language** (2.x), **platform facts** (3, 8.4, 14), **procedures with code** (4–7, 9), **constraints/anti-patterns** (10, 12), **volatile state** (13), **ecosystem/reference** (11). These map plausibly to `fact` / `procedure` / `constrains`-edged corrections / `state` / reference atoms with payload.
- Many claims are (subject, predicate, value) shaped — e.g. `xpath__pierces_shadow_dom__false`, `frontdoor_sid__status__deprecated_pressure` — suitable for 3-segment conflict-gated names; the code-bearing patterns are 2-segment facets with payloads.
- Confidence markers ([V-O]/[V-M]/[S]/[INF]) could carry into provenance suffixes or payload metadata.
- Section 13 items should be `state` atoms with tombstone-on-change discipline; section 14 items are long-lived facts.
- The "four suspects" diagnostic (8.3) and auth hierarchy (4.1) are ordered procedures — ordering must survive encoding (single atom with payload, or edge-chained steps).

---

## 16. Primary sources (deduplicated)

Official — Playwright: playwright.dev/docs/{locators, other-locators, auth, test-parallel, test-sharding, test-assertions, frames, api-testing, browser-contexts, trace-viewer, pom, best-practices}. Salesforce: developer.salesforce.com/docs/platform/lwc/guide/{create-dom-synthetic, create-mixed-shadow, create-light-dom, create-components-css-antipatterns, create-components-css-slds1-slds2, lightning-out-intro, unit-testing-using-jest-create-tests}; lightning-components-security/guide/{lws-intro, lws-architecture, lws-aura-endpoints}; lightning-component-reference (combobox, datatable, toast, spinner, modal, navigation); atlas.en-us.lightning.meta (components_ids, boxcar); UTAM overview; blogs (2023/05 base-component DOM changes, 2023/09 LEX performance plan, 2024/01 native shadow readiness). help.salesforce.com: frontdoor (000386254, xcloud.frontdoor_singleaccess, xcloud.security_frontdoorjsp), MFA waive/exempt (security_mfa_exclude_exempt_users, 000389361), release notes (LWS closed shadow 248, LWS rollout postponed 250), Experience Cloud (exp_cloud_plan_frameworks, exp_cloud_plan_licenses, guest access verification, domains, error pages), flow testing. GitHub: forcedotcom/cli#3249 (single-use org open URLs), microsoft/playwright#1784/#14471/#40985, salesforce/{codeceptjs-bdd, kagekiri, utam-js-recipes}, trailheadapps/ebikes-lwc, SalesforceLabs/Configurable-Self-Registration. npm: jsforce, wdio-utam-service, salesforce-pageobjects, @serenity-js/playwright, sfdx-browserforce-plugin.

Practitioner — himanshuai.substack.com (2026 complete guide); cassandrahl.com (POM vs UTAM vs Hercules); testrigtechnologies.com; medium.com/@abhijeetvaikar (jsforce); desplega.ai (2026 shadow DOM); verticalqa.com (selector ranking); testzeus.com (Summer '25 breakage); jitendrazaa.com (LWR architecture; Spring '26 guide); kms-technology.com; gearset.com; qaskills.sh; browserstack.com; varonis.com + cloud.google.com (aura endpoint structure); salesforceben.com (sharing model, licenses, SLDS 2); apexhours.com (composite, flow tests, jest); thedailycommit.com (scratch-org Playwright); admin.salesforce.com (self-registration flow).

