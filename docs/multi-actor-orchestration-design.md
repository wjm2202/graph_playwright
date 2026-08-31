# Multi-Actor Journey Orchestration — Design Options
_Status: for discussion · 2026-08-30 · builds on L2/FOUNDING-DOCUMENT.md §4 (auth), §8.2 (personas)_

## 1. Problem

Test journeys where **multiple users with different roles act in sequence on the same records**, proving the system cannot be gamed: an employee submits, a manager approves, an auditor verifies — and at every stage each actor can do exactly what their role allows and *nothing more*. Requirements:

- Simple login/logout **per role/account**, including several users active at once.
- A **JSON data structure** describing personas and journeys, easy to turn into e2e tests.
- A **meta layer** managing accounts, seeded data, orchestration, and timing.

## 2. The core mechanic: context = session

This is the insight everything else builds on. In Playwright, a `BrowserContext` is an isolated browser profile with its own cookies. Salesforce permits concurrent sessions for different users, so:

| Concept | Implementation |
|---|---|
| "Log in as X" | `browser.newContext({ storageState: '.auth/x.json' })` → instant, no login UI |
| "Log out X" | `context.close()` — the session simply stops being used |
| True server-side logout | navigate to `/secur/logout.jsp` first (only needed for session-limit or logout-behavior tests) |
| Two roles active at once | two contexts, two pages, in **one** test — interleave their actions to script the timeline |
| Same role in parallel workers | per-worker account clones (`.auth/approver-w0.json` — `workerStatePathFor()` already in `src/auth/storage.ts`) |
| Portal vs org actor | separate storageState per domain (sid cookies are domain-scoped — founding doc §4.3) |

Storage states are produced once per persona by a `setup` project (frontdoor / UI Bridge token injection, founding doc §4.2), then every journey "login" is a ~100ms context creation. Logout/login cycles cost nothing, so journeys can switch actors as often as the scenario demands.

## 3. Proposed JSON structures

### 3.1 `personas.json` — the account registry (build first, used by every option)

```json
{
  "org": { "instanceUrlEnv": "SF_INSTANCE_URL" },
  "sites": {
    "partners": { "urlEnv": "SF_SITE_PARTNERS_URL" }
  },
  "personas": {
    "employee_1": {
      "kind": "internal",
      "role": "Employee",
      "profile": "Standard User",
      "permissionSets": ["Expense_Submitter"],
      "usernameEnv": "SF_USER_EMPLOYEE1",
      "auth": "frontdoor",
      "poolSize": 1
    },
    "expense_approver": {
      "kind": "internal",
      "role": "Manager",
      "permissionSets": ["Expense_Approver"],
      "usernameEnv": "SF_USER_APPROVER",
      "auth": "frontdoor",
      "poolSize": 4
    },
    "partner_rep": {
      "kind": "portal",
      "site": "partners",
      "license": "Partner Community",
      "usernameEnv": "SF_USER_PARTNER1",
      "auth": "singleaccess"
    },
    "guest": { "kind": "guest", "site": "partners" }
  }
}
```

Rules: **no secrets in JSON** — env-var references only (`usernameEnv`; tokens/passwords resolved at setup time). `poolSize` declares how many clone accounts exist for parallel workers. `kind` + `site` select the auth mechanism and cookie domain automatically.

### 3.2 `journeys/*.json` — a journey as data (Option B)

```json
{
  "journey": "expense_approval_sod",
  "description": "Submit → approve → audit; no actor can act outside their role",
  "actors": {
    "submitter": "employee_1",
    "approver": "expense_approver",
    "auditor": "auditor"
  },
  "invariants": [
    { "rule": "distinctActors", "actors": ["submitter", "approver"] }
  ],
  "seed": [
    { "ref": "acct",    "sobject": "Account",     "fields": { "Name": "{unique:Acme}" } },
    { "ref": "expense", "sobject": "Expense__c",  "fields": { "Amount__c": 4999, "Account__c": "{ref:acct.id}" } }
  ],
  "steps": [
    { "actor": "submitter", "do": "expense.submit",  "with": { "expense": "{ref:expense}" },
      "expect": { "toast": "submitted" } },

    { "deny":  { "actor": "submitter", "capability": "expense.approve", "target": "{ref:expense}" } },
    { "deny":  { "actor": "approver",  "capability": "expense.editAmount", "target": "{ref:expense}" } },

    { "actor": "approver", "do": "expense.approve", "with": { "expense": "{ref:expense}" },
      "timing": { "notBefore": "prevStep", "maxDurationMs": 30000 } },

    { "actor": "auditor", "do": "expense.verifyAuditTrail",
      "with": { "expense": "{ref:expense}", "expectApprover": "expense_approver" } }
  ]
}
```

Design choices worth debating:

- **Steps reference a TypeScript step catalog** (`expense.submit` → a named function receiving `(page, journeyCtx, args)`), instead of encoding clicks in JSON. JSON stays small and stable; selectors/waits live in code where the component objects already are. This is the guard against DSL creep.
- **`deny` steps are first-class** — the anti-gaming half. Each is a *negative capability probe*: attempt the action as that actor and assert refusal (button absent, error toast, 403 on the API double-check). Journeys prove absence, not just presence.
- **`{unique:...}` / `{ref:...}` placeholders** bind to `utils/naming.uniqueName` and seeded record ids — collision-safe in parallel CI, sweepable after crashes.
- **`invariants`** are checked by the runner before execution (e.g. resolved submitter ≠ approver even after pool substitution) and after (audit-trail actor matches).
- **`timing`** covers ordering (steps are sequential by position; `notBefore` documents the handoff), SLA ceilings, and deliberate delays (`waitMs`) for time-sensitive flows.

## 4. Options

### Option A — `Cast` fixture + personas.json; journeys written as TypeScript specs
A fixture that turns any test into a multi-actor stage:

```ts
test('expense approval cannot be gamed', async ({ cast, seed }) => {
  const data = await seed({ ...expense seed... });

  const submitter = await cast.as('employee_1');       // Page, logged in
  await submitExpense(submitter, data.expense);

  await cast.deny('employee_1', approveButtonOn(data.expense));   // negative probe

  const approver = await cast.as('expense_approver');  // second live session
  await approve(approver, data.expense);

  const auditor = await cast.as('auditor');
  await verifyAuditTrail(auditor, data.expense, 'expense_approver');
});
```

`cast.as()` caches one context per persona and tears all of them down at test end; `cast.release()` = logout mid-test. **Cost: small (days).** Journeys are ordinary specs — full trace viewer, retries, sharding for free. Limitation: journey shape lives in code; authoring requires TS.

### Option B — Journey-JSON runner over a step catalog
One generic Playwright spec loads `journeys/*.json`, resolves actors via `Cast`, seeds via the API layer, executes steps from the catalog, enforces invariants/timing, and emits a per-journey report (who did what, when, which denials were verified). **Cost: medium (a week-ish, after A).** Wins: journeys are reviewable data — non-devs can read/author them, they can be generated, diffed, and **stored as atoms in the L2/MMPM substrate** (a journey is a `procedure` payload; step-catalog entries are the reusable vocabulary). Risk: the schema must stay small or it becomes a private language — the step catalog is the pressure valve.

### Option C — Account broker / full meta-system
A coordination layer above A+B: account **pool leasing** (workers check out `approver-w2`, return it), data lifecycle service (seed/sweep per run), a scheduler for cross-journey timing and staggered starts, and an audit collector aggregating UI evidence + SOQL-verified server state into one report. **Cost: large.** Justified when: parallel CI at scale, login-based portal licenses (leases = cost control), several teams sharing one org, or compliance reporting needs the consolidated evidence trail. Builds cleanly on A+B interfaces — nothing in A/B blocks it.

## 5. Recommendation

**A now, B's schema agreed now and implemented as a thin runner once the first journey passes, C deferred.** A is the substrate for all three; B is where the "JSON structure we can easily create an e2e test from" requirement lands; C only earns its cost at scale. Concretely next: (1) `personas.json` + schema, (2) `Cast` fixture with tests (harness: two contexts, cookie isolation proof), (3) `seed()` fixture over the existing `SalesforceApi`, (4) first real journey as a TS spec, (5) freeze the journey JSON schema from what that spec teaches us, (6) runner.

## 6. Open questions for discussion

1. **The journey domain**: which real flow is journey #1 (approval process? case escalation? partner deal reg?) — the step catalog vocabulary comes from it.
2. **Actors count & licenses**: how many distinct roles, and are portal personas (login-based licenses) involved? Drives pool sizing and whether C arrives sooner.
3. **Denial semantics**: is "button absent" enough proof, or must every deny also attempt the API call as that user (belt-and-braces, catches UI-only security)?
4. **Timing rigor**: do journeys need wall-clock choreography (actor B acts within N seconds / after a delay), or is strict ordering sufficient for v1?
5. **Where journeys live**: repo JSON only, or also encoded into the MMPM substrate so the meta-system can query "which journeys cover role X / object Y"?

---

## 7. Human-driven codegen: record → distill → generate → run

_Added 2026-08-30: the user drives the journey; the system writes the spec — including learned wait-time baselines so a broken step is flagged with expected-vs-actual timing._

### 7.1 Pipeline

```
┌──────────┐   raw events + timestamps   ┌───────────┐   semantic steps    ┌───────────┐
│ RECORDER │ ───────────────────────────▶│ DISTILLER │ ───────────────────▶│ GENERATOR │
│ human    │   (actions, nav, network,   │ action    │   + observed waits  │ journey   │
│ drives   │    settle signals, values)  │ grammar   │   + data points     │ JSON +    │
└──────────┘                             └───────────┘                     │ baselines │
     ▲                                        ▲                            └─────┬─────┘
     │ persona-authenticated context          │ repeat recordings                │
     │ from personas.json (Cast)              │ refine baselines (mean/p95)      ▼
     │                                        │                            ┌───────────┐
     └────────────────────────────────────────┴────────────────────────────│  RUNNER   │
                                              re-record only what changed  │ budgets + │
                                                                           │ deviation │
                                                                           │ report    │
                                                                           └───────────┘
```

**Recorder.** A small `record` script: pick a persona → launch a *headed* Playwright context pre-authenticated via `Cast` (so the recording starts inside the journey, not at a login form) → the human performs the flow. Multi-actor journeys are recorded as one session per actor; the distiller stitches them on the shared records (the expense the submitter created is the one the approver touches).

**Distiller.** Raw events are noisy; an **action grammar** collapses them into the step-catalog vocabulary — the same recognizers the founding doc's component patterns imply:

| Raw sequence observed | Distilled step |
|---|---|
| click `role=combobox "Stage"` → click `role=option "Closed Won"` | `combobox.select("Stage", "Closed Won")` |
| fill `label "Amount"` = `4999` | `form.fill("Amount", 4999)` → journey `with` arg |
| navigation to `/lightning/r/Expense__c/…/view` | `recordPage.open(Expense__c, {ref})` |
| click `role=button "Save"` → spinner → toast "was saved" | `modal.save()` + `expect.toast(/was saved/)` |

Unrecognized sequences are kept as raw fallback steps and **flagged for naming** — every time a human names one, the step catalog (and the action grammar) grows. That's the compounding labour reduction: the second journey is mostly recognized; the tenth is entirely vocabulary.

**Timing capture — the "quick feedback" mechanism.** For every step the distiller records two things:
1. **The settle signal** — what the human actually waited for (spinner detached, toast appeared, heading rendered, aura response returned). That becomes the generated wait condition, so the spec waits on the *right* thing, not a guess.
2. **The duration** — action start → settle. Across recordings/runs these accumulate into `baselines.json`:

```json
{
  "journey": "expense_approval_sod",
  "steps": {
    "3:approver/expense.approve": { "n": 14, "meanMs": 1240, "p95Ms": 2100, "updated": "2026-08-30" }
  },
  "budgets": { "softFactor": 1.5, "hardFactor": 3.0 }
}
```

The runner then gives **graded feedback**: over `p95 × softFactor` → the step *passes but is flagged* ("approve took 4.2s, baseline 2.1s") — perf drift caught before it becomes a timeout; over `p95 × hardFactor` → fail fast at that step with expected-vs-actual, instead of a generic 30s timeout three steps later. Baselines update on green runs (rolling window), so seasonal-release drift is visible as a trend, not a surprise.

**Generator.** Emits the §3.2 journey JSON (steps, `with` data extracted from what the human typed, assertion candidates from what the human saw) plus step-catalog stubs for anything unrecognized. Recordings feed the *same* Option-B runner — no separate "recorded test" species to maintain.

### 7.2 Two capture implementations (choose one for v1)

| | **v1 candidate: trace-based** | **v2 target: injected recorder** |
|---|---|---|
| How | Record with Playwright tracing + HAR on; distill the trace's action timeline | Init-script in the context: capture-phase listeners + `event.composedPath()` (sees through shadow DOM) + MutationObserver for spinners/toasts, streamed out via `exposeFunction` |
| Effort | Small — no injection code | Medium |
| Signal quality | Actions + timestamps + network; settle signals inferred | Exactly our locator vocabulary (role, accessible name, `data-label`, `field-name`), settle signals observed directly, aura calls correlated per step |
| Risk | Trace file format is Playwright-internal, not a public API — parser may need touch-ups on upgrades | CSP/LWS: init scripts run in the main world, which practitioner evidence says is fine, but it's custom code we own |

Recommendation: **v1 trace-based** to prove the pipeline end-to-end cheaply; promote to the injected recorder when the action grammar stabilizes (it's also the piece that later feeds live "watch mode" — a human demonstrates a fix, the journey updates).

### 7.3 What this changes in the §5 build order

`personas.json` + `Cast` stay first (the recorder needs authenticated contexts). Then: **record script → distiller with a starter grammar (combobox/fill/nav/save-toast) → generator → runner with baselines.** The first journey is now *whatever you record first* — open question 1 answers itself, and questions 3/4 get defaults: denials stay authored (recording can't demonstrate what a role *can't* do — deny steps are added to the JSON by hand or by running the recorder as the wrong persona and capturing the refusal), and timing rigor starts as ordering + learned budgets rather than wall-clock choreography.
