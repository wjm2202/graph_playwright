# HANDOVER — Salesforce Playwright L2 Project

*Written 2026-08-30, end of session 2. Substrate connector: salesforce-mcp (the
"typescriot-mcp" connector in Cowork — same server).*

## Paste-this-first bootstrap for the next session

Bootstrap the **salesforce-mcp** substrate (`memory_session_bootstrap`,
objective = the session's task) — the full research corpus and all project
decisions/state live there now (treeVersion 32). Then read this file. Repo:
`~/Documents/code/SalesForce/salesforce_playwright/` (re-request folder access).

## Sprint S18 OPEN SOURCE — SHIPPED 2026-08-31 (AGPL-3.0)

Owner decision: open source for personal AND professional use, with the
give-back intent expressed through **AGPL-3.0** (user-selected over
GPL/MPL/Apache after the honest caveat: no OSI license can compel purely
INTERNAL users to contribute; AGPL is the strongest real-open-source
expression of the intent — distribution or network service of a modified
version must be open). Copyright: "the salesforce_playwright contributors".
Shipped: LICENSE (verbatim SPDX AGPL-3.0-only text), CONTRIBUTING.md (tests
for everything, three gates, DCO sign-off, secrets rules, planner-build
rule, good first areas), package.json license AGPL-3.0-only + description,
README License & contributing section. Scrub scan: zero personal
identifiers/sandbox paths in publishable files; HANDOVER/docs/L2 published
by owner choice. Not-a-lawyer caveat given; recommend counsel look before
announce.

## Sprints S16+S17 nUIA + ESLINT/CI — SHIPPED 2026-08-31 (suite 336, lint 0)

- **S16**: noUncheckedIndexedAccess promoted into tsconfig.json — the FULL
  Microsoft 5.9 baseline now enforced. 79 src sites fixed properly (guards,
  for-of anchors, invariant-commented `!`, source-level `?? default`s), 116
  test sites via compiler-position-driven `!` insertion (script) + 13 manual.
  nPAFIS dropped (stylistic; not in Microsoft's baseline); ratchet config
  deleted. One behavior finding: parseInternalSelector now OMITS `name`
  instead of explicit-undefined (exactOptional semantics).
- **S17**: eslint + typescript-eslint (strict-type-checked + stylistic-
  type-checked, flat config). Principled carve-outs, each commented in
  eslint.config.mjs: validators keep "unnecessary" checks (malformed-JSON
  defence); tests may use `!`/unsafe-*/require/empty-fns; `!` in src needs a
  comment (house rule replaces no-non-null-assertion); `||` kept where ''
  means unset (env vars). New src/utils/text.ts asText() fixes the
  no-base-to-string family honestly (trace args are unknown). 464 findings →
  0. `npm run lint` + .github/workflows/ci.yml (typecheck + lint + suite,
  no secrets — e2e self-skips).

## Sprint S15 GITHUB-READINESS REVIEW — SHIPPED 2026-08-31 (suite 336)

Reviewed against the substrate's TypeScript standards cache (hub_typescript_
standards — Microsoft's 5.9 baseline + Google style prescriptions).

- **tsconfig raised**: + exactOptionalPropertyTypes, noImplicitOverride,
  noImplicitReturns, noFallthroughCasesInSwitch, noUnusedLocals,
  noUnusedParameters (24+7 sites fixed). New `src/utils/compact.ts`
  (Compacted<const T> — drops undefined at runtime AND in the type,
  preserves literal kinds; the one blessed cast, commented + tested).
  Pass-through params use explicit `personaIds?: string[] | undefined`.
- **Ratchet**: `npm run typecheck:strictest` (tsconfig.strictest.json) runs
  the two remaining baseline flags — noUncheckedIndexedAccess (+
  noPropertyAccessFromIndexSignature), ~195 sites; promote when zero.
- **Audit findings**: zero `any`, zero @ts-ignore, zero TODOs; casts confined
  to tests (idiom) + 2 justified src sites; console.* only in CLIs.
- **Hygiene**: .gitignore + .DS_Store + journeys/telemetry.jsonl; stray
  .DS_Store removed; package.json license UNLICENSED + engines node>=18;
  README rewritten as the GitHub front page (loop, quickstart, command
  table, layout, secrets discipline).
- **Staged (not adopted)**: ESLint — typescript-eslint 8.x supports our TS
  5.6 (needs <6.1); oxlint w/ type-aware rules is the fast alternative.
  Adopt as its own sprint with CI. module stays commonjs (Playwright CJS
  runtime); nodenext/verbatimModuleSyntax deferred with it.

## Sprint S14 TOTP — SHIPPED 2026-08-31 (suite 333)

- **src/auth/totp.ts** — zero-dep RFC 6238 (verified against Appendix B
  vectors, sha1/sha256/sha512): tolerant base32, any digits/period,
  `parseOtpauth` (the secret in .env may be raw base32 OR the enrollment
  screen's full otpauth:// URL — its digits/period/algorithm are honored),
  `totpNow` (waits out the period boundary when a code has <2s life),
  `totpForPersona` (registry → totpEnv → .env, exact-name errors).
- **src/auth/totp-challenge.ts** — implementation-agnostic challenge
  handler: detects SF's #tc verify screen / autocomplete="one-time-code" /
  otp-verification-code-named inputs (selectors overridable), fills at
  code-generation time, clicks verify/continue or falls back to Enter.
  Outcomes explicit: none | filled | challenged-no-secret.
- **Cast ui login** answers MFA automatically when the persona's totpEnv is
  set; a challenge WITHOUT a secret fails loudly with the exact .env name
  to fill. Token-injection tiers (frontdoor/singleaccess) bypass MFA and
  are untouched.

## Sprint S13 CRED OPT-OUT + HEADER FIX — SHIPPED 2026-08-31 (suite 322)

- Optional credentials (password/token/totp) get a ✕ on the card: "this
  system doesn't use X" — clears the mapping in personas.json, line shows
  a neutral – "not used by this system" with placeholder "(not used — type a
  name to wire it)". url/username never clearable. Server warns (never
  blocks) when clearing leaves neither password nor token — persona can't
  authenticate until one is wired; warning surfaces in the status bar.
- Card header chips (● record now / SESSION) moved to their own row under
  the title — the float was squeezing the label input to ~90px.

## Sprint S12 FULL-WIDTH CANVAS + STALE-SERVER GUIDANCE — SHIPPED 2026-08-31 (suite 319)

- The right-hand aside is GONE — graph meta (id/title/systems/actors) is now
  a card toggled by the toolbar `graph` button; `new` opens it and focuses
  the id. Canvas gets the full window width.
- Served-mode is detected by PROTOCOL (http/https), not by a successful
  endpoint fetch — a dev server older than the page is NAMED out loud
  ("restart it: Ctrl+C, then npm run planner") in the creds box, the status
  bar, and on failed saves, instead of silently downgrading to read-only.
  window.PLANNER_FORCE_SERVED overrides for tests.
- Card-glue test is flip-aware (the card hugs whichever side of the node
  fits the viewport).

## Sprint S11 EDITABLE ENV WIRING — SHIPPED 2026-08-31 (suite 317 passed)

Teams keep their existing .env names: the card's credential lines are INPUTS
when served (`npm run planner`) — rename e.g. SF_SALES_USERNAME →
SFDC_UAT_USERNAME and it POSTs /__personas on the dev server, which
validates (names-only; the ≥12-chars-no-underscore pasted-secret rule;
usernameEnv required; guests refused) and writes personas.json atomically.
urlEnv routes to the persona's site else the org. .env itself is NEVER
touched. Response returns fresh wiring + envstatus → dots recolor live;
refusals report why in the status bar and snap the input back to disk truth.
file:// stays read-only with guidance. PLANNER_ROOT env overrides the data
dir (tests spawn a real server on a throwaway root; PLANNER_PORT=0
supported, actual port echoed). Planner-page boot wait in harness raised to
30s — the ~1MB single file can exceed 15s under parallel sandbox load.

## Sprint S10 CARD CREDS + RECORDED CHIP — SHIPPED 2026-08-31 (suite 315 passed)

- **Credentials on the session card**: url / username / password / token /
  totp env NAMES from personas.json (values never leave .env). Neutral dots
  on file://; via `npm run planner` the dev server's /__envstatus endpoint
  reports SET/UNSET booleans and the dots go green/red. Guests say
  "unauthenticated". `totpEnv` added to the persona schema (+ .env.example
  entries, pool-suffixed, names-only enforced) — doctor notes an unset totp
  informationally, never blocking.
- Validator hardened: an *Env value ≥12 chars with no underscore (a pasted
  base32 TOTP seed / token) is now rejected as an inline secret.
- **Recorded chip** on session/action cards: green "● recorded" (button →
  "↻ re-record") vs amber "● record now".
- **Compact cards**: two-column rows (label beside input); tall rows
  (creds/checks/capture/snapshot/notes) opt out via .wide. account env row
  moved behind "extra settings" (the creds block shows it better).
- planner.select() is now true single-select (unselect-then-select) — the
  old additive select silently skipped re-renders.

## Sprint S9 NODE CARDS — SHIPPED 2026-08-31 (suite 312 passed)

n8n-style editing: node/edge settings live ON the canvas element, not a side
panel. Click a node → it grows (selected style) and a card flies out beside
it, GLUED through pan/zoom/drag (rAF-throttled). Per-type tiering
(NODE_TIERS): primary fields on the card (session: label/url/role/account/
capture/snapshot — the founding four data points; db: queryable; api:
method+path; data/checkpoint: checks+snapshot), the rest behind an "extra
settings" toggle, foreign fields hidden entirely. start/end say "nothing to
configure". Edges get the same card at their midpoint. The side panel now
holds only GRAPH meta (id/title/systems/actors). All original element ids
preserved — every pre-existing panel test still passes unchanged.
Sandbox note: cy.panBy crashes the SANDBOX headless chromium (env quirk, not
a planner bug) — glue tests use node position moves; never add panBy to
tests here.

## Sprint S8 CHECK PANEL + TOOLTIPS — SHIPPED 2026-08-31 (suite 310 passed)

- **check button** (live badge: `check ✓` green / `check (n)` amber / red when
  invalid, updated on every edit). Opens the **graph check** panel: MUST FIX
  (validateGraph errors, red) + TO FINISH (the grillme gap engine's questions
  as hints, amber) — every row click-jumps to the offending node/edge; clean
  graph earns the green "valid and complete" line. gaps.ts + the personas.json
  id roster are now inlined at build (window.ProcessGraphGaps / PERSONA_IDS),
  so role_unbound is caught in the browser too.
- **Canvas hover tooltips** — every node/edge type explains itself in one
  sentence (db: "NOT queryable: verify via the app API or a log system";
  unbound does: "name or capture it"); `planner.tipFor(id)` is the tested
  pure core. Title tooltips added across toolbar controls.
- serve-planner now watches gaps.ts + personas.json too.

## Sprint S7 EXTENSIBILITY — SHIPPED 2026-08-31 (suite 307 passed)

Infra nodes as first-class evidence sources + a planner UX pass:

- **Node types db / logger / api** (schema + planner + mermaid). db carries
  `queryable` (default NO — many DBs can't be reached; validation REFUSES a
  db.query against a non-queryable db and names the way out: app API or
  logs). logger carries `searchable`. api carries `endpoint {method, path}`
  (e.g. create_customer_v2) — worn on the node label.
- **Oracle kinds db.query / log.traffic** — target = the db/logger NODE ID,
  value = the query / search term. Same apiOracle seam, same polling
  (log search almost always needs a budget; grillme now asks about all
  backend kinds). Skipped-not-passed when no adapter is bound.
- **Planner UX**: `new` button (fresh graph arrives with start+end, focus on
  the id field); `add ▾` typed palette with readable ids (db_1, api_1,
  sess_1) and per-type hints; **type-aware panel** (only the fields the
  selected type uses — db shows the queryable switch, session shows
  role/capture, api shows method+path); distinct shapes/colors; `?` legend
  card (click to dismiss — an overlay-blocks-button bug was caught by test).
- lead_to_customer now models the real integration: customer →(handoff)
  api_create_customer_v2 →(creates) customer_siebel, api →touches→ Siebel DB
  (not queryable, noted why) + API gateway logs; checkpoint gained a DRAFT
  log.traffic check ('create_customer_v2', 60s/5s) for grillme to confirm.

## Sprint S-SCAFFOLD — SHIPPED 2026-08-31 (docs/REVIEW-AI-SCAFFOLD-PRESTEP.md)

The AI-scaffold pre-step: AI drafts everything describable, the human's only
remaining work is captures + one-beat judgments. Suite 296 passed. Shipped:

- **Polling oracles** — `expects[]` gains `timeoutMs`/`pollMs` (+`draft`);
  api.* oracles POLL to the deadline (throw = precise stop), ui.* honor the
  override. lead_to_customer's Siebel checkpoint now 120s/5s. Planner rows
  expose the budget for api kinds.
- **Capture-first v2** — `src/graph/fromCapture.ts`: ONE recording →
  compact session→does→data graph (post-save redirects folded in, SObjects
  inferred, draft oracles api.record_exists/ui.url flagged `draft?`) + a
  composite steps module replaying journey slices (`src/journeys/slice.ts`).
  `PIPELINE_GRAPH=1` on `npm run pipeline` emits it (never over an authored
  graph without `PIPELINE_GRAPH_OVERWRITE=1`).
- **Env doctor** — `GRAPH_DOCTOR=<id|all> npm run doctor`: per-graph ✓/✗ for
  org URL, site URLs, every persona, plus the exact .env skeleton to paste.
- **Readiness cockpit** — planner status bar `captured n/m · bound n/m ·
  checks n (k drafts)`; captured sessions labeled `✓rec`; does edges get
  convention name suggestions (`<noun>.<verb>`); draft checks carry a
  `draft?` confirm-once button.
- **Labour telemetry** — `journeys/telemetry.jsonl` (capture/pipeline/run
  events, best-effort) via src/telemetry.ts; `npm run labour` prints
  scaffold→first-green wall clock per id. Proves/refutes the 50% target.
- **ado:import** — `ADO_FILE=<csv>` or `ADO_PASTE=<text>` `npm run
  ado:import` → draft graph (roles→sessions, steps→does edges, expected
  results→draft oracles, Siebel auto-provisioned maxConcurrent 1), every
  guess flagged; never clobbers (suffix `_ado`). Mapping validated on
  fixtures; PENDING validation against a real ADO export.
- **/grillme** — Cowork skill (saved to account) + engine
  `src/graph/gaps.ts` (`computeGaps` 9 gap kinds phrased as multiple-choice
  questions; `applyAnswers` 8 validated write-back ops) + CLI
  `GRILLME=<id> [GRILLME_APPLY=<ops.json>] npm run grillme`. Demo draft:
  `journeys/graphs/lead_to_customer_via_ado.graph.json` (20 gaps listed).

Still creds-blocked (user adds .env later): capture queue + pre-navigation,
org atlas harvest, ADO REST + write-back, AI-drafted capture experiment.
Sandbox note: never probe /proc paths in tests — bwrap blocks instead of
erroring (cost a suite hang; fixed with an ENOTDIR probe).

## Where the project stands (session 2 executed the plan)

| Step | Status |
|---|---|
| 1. Research corpus | DONE (session 1) — L2/FOUNDING-DOCUMENT.md |
| 2. Atom schema + encode into substrate | **DONE** — 163 atoms / 508 edges, 10 batches, retrieval spot-checked. Schema + maintenance rules: `L2/ATOM-SCHEMA.md`; batches + validator: `L2/encoding/` (`npm run validate:encoding`) |
| 3. Multi-actor build | **Runner MVP DONE** — personas + Cast + seed + journey runner all shipped and tested |

**Suite: 101 passed, 5 env-gated e2e skips, typecheck clean.** (Sandbox browser
recipe, if working in Cowork again: memory atom
`v1.procedure.cowork_sandbox__browser_test_recipe` — never ship it.)

## What shipped in session 2 (all tested)

- `personas.json` + `src/personas/` — schema validator (env-var NAMES only;
  inline secrets REJECTED), registry (pool `_W<n>` suffixing, legacy `SF_*`
  fallback for admin), multi-persona `.env.example`.
- `src/fixtures/cast.ts` — **Cast**: context = session; `as()` cached ~100ms
  logins, several personas live at once, `release()` = logout, `deny()` =
  UI + API negative capability probe, auth ladder (storageState → token
  frontdoor/singleaccess → UI login → actionable error). Guest = empty state.
- `src/data/seed.ts` — ordered seeding with `{unique:}` / `{ref:x.y}` /
  `{runId}` placeholders; teardown rides SalesforceApi.deleteAll().
- `src/journeys/` — journey-as-JSON schema + validation; StepCatalog (deny
  probes MANDATORY per capability — no vacuous denials); runner (invariants →
  seed → steps → per-step report; baselines grading p95×1.5 soft-flag /
  p95×3 fail-fast; `maxDurationMs` ceilings; `waitMs` choreography).
- `journeys/expense_approval_sod.json` — reference SoD journey; proven
  end-to-end in harness (incl. a leak-detector negative) in
  `tests/harness/journey-runner.spec.ts`.
- `tests/e2e/multi-persona-smoke.spec.ts` + `SETUP-REAL-ORG.md` — the moment
  .env creds exist, the smoke proves login → LEX per persona and two live
  sessions at once. Each unconfigured persona skips naming its exact env vars.

## Decisions taken (also in substrate under hub_decisions)

Deny semantics = **UI + API probe** · v1 roster = **admin / sales_user /
portal_user / guest** · journeys **are** encoded into the substrate
(hub_sf_journeys) · hub style = resident single-underscore `hub_sf_*`.

## Sprint S-GRAPH-2 — v2 RELATION MODEL SHIPPED 2026-08-31 (docs/STUDY-TEST-GRAPH-REPRESENTATION.md)

`process-graph/2`: NODES are states (session = system×role/account, screen,
data, checkpoint), EDGES are relations (`login_as` w/ auth, `does` w/ catalog,
`requires`, `touches`, `asserts`, `denied`). Superset validator (v1 loads
forever), `upgradeGraph()` v1→v2 converter, v2 login-chain journey walker
(does/denied per session → steps; requires → prerequisite metadata), planner
styles+edge forms for all relation types, mermaid/toBatch updated, seed
`expense_to_siebel.graph.json` rewritten as relations
(start —login_as→ sf·submitter —does expense.submit→ Expense record …).
Capture chain proven: fixture → distill → v1 graph → upgrade → valid v2.
Suite **224 passed / 4 gated skips**. Planner dev loop: `npm run planner`
(auto-rebuild + live reload; requires `npm install` locally once).

## Sprint S-GRAPH — SHIPPED 2026-08-31 (docs/DESIGN-PROCESS-GRAPH.md)

Process-graph layer complete, suite **202 passed / 4 gated skips**: `src/graph/`
(schema+validation, capture→graph per-step & aggregate DFG, mermaid export,
graph→journey skeletons with deny mapping + `plan.*` placeholders, substrate
batch emitter) · `tools/process-planner.html` — 803KB SELF-CONTAINED
cytoscape+dagre planner (edit/view modes, four data points per node incl.
snapshot paste, dagre layout, import/export .graph.json), rebuilt via
`npm run build:planner`, driven by 10 harness tests · Cast `sessionPolicies`:
Siebel-style `maxConcurrent` enforced by logout-to-comply LRU eviction
(`cast.evictions` audit trail) · seed graph `journeys/graphs/expense_to_siebel.graph.json`.
Graph batches (`batch-graph-*.json`) follow review-then-publish; nothing
auto-checkpoints. D3 reminder: capture-graphs are ON DEMAND (owner call).

## Sprint S-REC status (updated 2026-08-31; doc: docs/SPRINT-RECORDER-PIPELINE.md)

**R0–R7 SHIPPED, G1 PASSED** (substrate treeVersion 36; suite **163 passed /
4 gated skips**, typecheck 0, validator publishable). The loop is proven:
`npm run record` (headed Cast session, close-window-to-finish) → version-pinned
trace reader → distiller (starter grammar + settle attribution + name-me flags)
→ generator (journey JSON + WORKING vocabulary steps + baselines + reviewed
settle-contract batches) → `npm run pipeline` → the real runner replays the
generated journey VERBATIM (tests/harness/generated-journey.spec.ts).
Deny captures: `RECORD_EXPECT_DENIAL=1` + `PIPELINE_CAPABILITY=…`; a captured
success REFUSES to generate. Multi-actor: one recording per persona, stitched
on wall-clock with cross-actor shared-id flags (`PIPELINE_ALIASES=…`).

**Remaining:** R8 real-org binding — blocked on H0 (npm install + git init,
SETUP-REAL-ORG.md, pick journey #1), then: record the real flow → pipeline →
implement flagged raw steps → e2e green → 3-run baselines. R9 — publish REAL
settle-contract batches after review (the fixture batch in tests/fixtures/
never publishes), measure G3 (journey #2 ≥50% under hand-authoring), phase
supersede. Stretch S1 (CDP raw-session capture) untouched. Option C deferred.

**Playwright upgrades:** regenerate fixtures (`GEN_FIXTURE=1` on
make-fixture-trace.spec.ts then make-fixture-artifacts.spec.ts), re-run suite —
the trace reader is pinned and fails loudly on unknown formats.

## Housekeeping

- `../salesforce-playwright-research.md` is a duplicate of the founding doc —
  user may delete.
- No git repo yet (`git init` recommended before real-org work; commits stay
  human-only).
- User has NOT yet run `npm install` on the Mac (node_modules here came from
  sandbox runs; `npm install` locally before first Mac run).
