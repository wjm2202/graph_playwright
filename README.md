# graph_playwright

**Graph-based, multi-actor Playwright testing.** You draw a business process
as a graph, record each step once as the human who actually does it, and the
project generates the Playwright tests — then repaints the *same graph* with
pass/fail, timings and screenshots.

Salesforce is the implemented adapter (Lightning components, frontdoor auth,
the REST API, MFA), with downstream systems — Siebel, databases, log systems,
integration APIs — modelled as first-class evidence sources. The graph layer
itself knows nothing about Salesforce.

## The loop

```
plan graph (planner UI / ADO import / one recording)
   → journey (walker) → run (multi-actor sessions, oracles, screenshots)
   → merge-back (the SAME graph repaints: pass/fail, timings, snapshots)
```

The graph is the plan, the test source, and the report. There is no second
artifact to keep in sync.

## Quickstart

```bash
npm install
npx playwright install chromium
npm test                      # unit + harness — green with NO org, no .env
npm run planner               # visual planner on http://127.0.0.1:8765
```

To run against a real org: `cp .env.example .env`, fill it (see
[SETUP-REAL-ORG.md](SETUP-REAL-ORG.md)), then let the doctor tell you exactly
what's still missing:

```bash
GRAPH_DOCTOR=all npm run doctor
```

---

## Creating a graph

Two ways in. Both end at the same place: a `.graph.json` in a project, a
**check ✓** badge in the planner, and a capture queue. The rules every graph
must satisfy are in [docs/GRAPH-SPEC.md](docs/GRAPH-SPEC.md); an AI can
follow [skills/graph-author/SKILL.md](skills/graph-author/SKILL.md) to do
the completing with you.

Before either path, once:

```bash
npm run planner                     # http://127.0.0.1:8765 — auto-rebuild, live reload
```

and know the three layers a session's credentials pass through
(`docs/DESIGN-ROLES-ACCOUNTS.md`): a graph binds a **role** alias to a
persona in `personas.json`; the persona names the **account** it logs in
as; the account's env names are derived (`SF_<ACCOUNT>_USERNAME/_PASSWORD`,
optional `_TOKEN`/`_TOTP_SECRET`) and their values live only in `.env`.
Several roles may share one login. A graph never invents accounts.

### Path A — draw it by hand

1. **Project.** In the toolbar, PROJECT → `＋ new project…` and name it
   (lower-case, e.g. `crm`). This creates `projects/crm/` with `graphs/`,
   `imports/`, `steps/`, `specs/`… A graph belongs to a project.
2. **New graph.** FILE → **new**. You get `start` and `end` waiting. Click
   **graph** and give it an id (`create_customer`) and a title; add the
   systems it touches (`sf` is there; add `siebel` with *one session max* if
   the flow crosses into Siebel).
3. **People first.** EDIT → **add ▾ → personas…** and paste the role names
   (the ADO "Personas who can perform this action: …" line works as-is), or
   tick personas from `personas.json`. Each becomes a role in this graph.
   For roles the roster doesn't have, a *logs in as* row appears: a new
   login named after the role (default), the same login as another pasted
   role, or an existing account. Apply writes `personas.json` and shows
   one `.env` block per **new login** — paste it into `.env` and fill the
   values (the names are already in `.env.example`).
4. **Sessions — who, where.** EDIT → **add ▾ → session** once per role ×
   system: e.g. `Salesforce · client_lead`. On the session's card pick the
   **system** and the **role / user** (the roles you just added, plus any
   other persona from the roster — picking one adds the role); set the
   **landing URL** (the list or record page the role starts on — this
   enables pre-navigation so captures skip login).
5. **Wire the login chain.** Drag from the edge of `start` to the first
   session, then from each session to the next: these are `login_as` edges
   (select one to set the auth method if it differs from the persona's). One
   linear chain — no branches, no cycles; every session must be on it.
6. **Records — what exists.** **add ▾ → data** for each business record the
   flow creates or touches (`Customer record`, SObject `Account`). One data
   node per record, even if several roles touch it — that node is the join.
7. **Steps — what each role does.** Drag from a session to a data node (or a
   screen/checkpoint): a `does` edge. On its card: the **label** ("create
   customer"), the **step catalog** name (`cust.create`, `<noun>.<verb>`),
   and — for edges onto data — the **data port**: *produces* (this step
   creates the record), *consumes* (reads it), *updates*. The port is how the
   record's id reaches later steps, including steps in a graph you insert
   later.
8. **What must be true.** On each data/checkpoint node's card, add checks:
   `api.record_exists` / `api.field_equals` (SObject, `Field=Value`),
   `ui.toast` / `ui.text` / `ui.url`, or `db.query` / `log.traffic` against a
   db/logger node. Use **after** to tie a check to the step that causes it;
   give backend checks on async integrations a polling budget.
9. **What must be refused.** For any multi-role flow, drag from a session to
   the record and set the relation to `denied` with the capability
   (`cust.delete`) — the security half of the test.
10. **Check.** Click **check** — MUST FIX (validator) and TO FINISH (gap
   questions) grouped by element; each row jumps to the culprit. Iterate
   until the badge is **check ✓** with only *not captured* left. `⌘Z` undoes
   any delete/insert/connect.
11. **Save into the project.** FILE → **save ▾ → save to project "crm"**.
    The dev server validates and writes
    `projects/crm/graphs/create_customer.graph.json` (asks before
    overwriting), the library refreshes and the graph reopens from the
    project. *save … in this browser* is the offline fallback; **download**
    gives you the file to place by hand.
12. **Capture and run.** Double-click each session to copy its record
    command (`RECORD_PERSONA=… RECORD_JOURNEY=… npm run record`), record it
    once as that human; then `SUITE=graph:crm/create_customer npm run suite`
    runs it — one generic spec walks whatever the suite selects, and every
    run repaints the graph. Put the graph in `suites.json` (or give it a
    `tags` entry) to make it part of a standing suite.

Extending a flow: FILE → **insert ▾** brings another graph in as a
selected island parked to the right; drag it where you want, draw one
`login_as` into it, relink `end`. Shared data nodes merge, and the status
line names which session the island must follow so its records exist first.

### Path B — import test cases from Azure DevOps (Excel)

1. **Export from ADO.** Either
   *Test Plans → your suite → ⋯ → Export test cases → Excel* (one row per
   step: `ID · Work Item Type · Title · Test Step · Step Action · Step
   Expected`), or *Queries → your query → Export to CSV* with the **Steps**
   column included. Both layouts are recognised; keep the **Title** column.
   Write the steps ADO-style — `As <role>, <action>` with an expected result
   — and the importer gets the roles, records and checks right.
2. **Planner → import cases.** FILE → **import cases** (dev server only).
3. **Project.** Pick an existing project or `＋ new project…` and name it.
   The file will be stored under that project.
4. **File.** Choose the `.xlsx` / `.csv`, click **read test cases**. The file
   is copied verbatim to `projects/<p>/imports/<stamp>-<name>.xlsx` next to
   a manifest, then parsed.
5. **Pick.** Every test case is listed with its step count, ticked by
   default. Untick what you don't want now — it stays in the stored import
   for later (*previous imports in this project* re-opens it, no re-upload).
6. **Import selected.** One draft graph per case lands in
   `projects/<p>/graphs/<slug-of-title>.graph.json`; the results list has an
   **open** button for each and the planner lands on the first after the
   rebuild.
7. **Understand what you got.** `As admin, …` → a session bound to alias
   `admin`; each step → a `does` edge named `<object>.<verb>`; nouns the
   expected result says were created/saved → data nodes; the verb → a *draft*
   port; the expected text → a *draft* check. Every guess is flagged.
8. **Complete each graph.** Open it, click **check**, and answer the TO
   FINISH questions (bind roles, confirm or drop each `draft?` check, confirm
   ports, session policy, URLs). Or from a terminal:
   `GRILLME=<p>/<id> npm run grillme` lists the same questions; answers go
   back as a JSON ops file with `GRILLME_APPLY=`. Point your own AI at
   `skills/graph-author/SKILL.md` and it will run this loop with you.
9. **Capture and run** — as in Path A step 12.

CLI equivalent of steps 2–6: `ADO_FILE=export.xlsx npm run ado:import`
(writes to `journeys/graphs/`).

## Features

### The graph model

- **States and relations, not boxes and arrows.** Nodes are states — `session`
  (a system × role/account), `screen`, `data`, `checkpoint` — plus the
  evidence sources `db`, `logger` and `api`. Edges are relations: `login_as`,
  `does`, `requires`, `touches`, `asserts`, `denied`.
- **Evidence sources are honest about themselves.** A `db` node carries
  `queryable` (default *no* — most production DBs aren't reachable from a test
  runner) and validation **refuses** a `db.query` check against a
  non-queryable DB, naming the way out: the app API or the log system. A
  `logger` carries `searchable`; an `api` node carries its `{method, path}`.
- **Data flows on the edges.** A `data` node is a runtime variable; every
  edge onto it carries a port — `produces` (the step publishes the record's
  id), `consumes` (the step receives `{ref:<node>.id}`) or `updates`. A
  reaching-definitions check refuses use-before-def, composing graphs
  infers where the imported flow must splice in, and the recorder derives
  the ports itself (the save that created a record defines it; every later
  mention becomes `{ref:}`). Study + science: `docs/STUDY-DATA-FLOW.md`.
- **One authoring form.** `process-graph/2` is the only shape the validator,
  the walker and the planner know; a legacy `process-graph/1` file still
  opens because `upgradeGraph()` converts it at the load door.
- **Merge-back.** A run's results are merged onto the graph it came from —
  every node paints pass/fail with its duration and the screenshot the run
  captured.
- **Suites, not generated specs.** `suites.json` names selections — explicit
  `graphs`, a graph `tags` list, or a whole `project` — and ONE spec
  (`tests/e2e/graphs.spec.ts`) runs whatever `SUITE=` selects, one test per
  graph × persona-matrix binding. `SUITE=smoke npm run suite`; nothing is
  code-generated, so a graph joins a suite by being tagged.

### Authoring — the visual planner

`npm run planner` serves a self-contained cytoscape + dagre planner with
auto-rebuild and live reload.

- **Editing on the canvas, not in a side panel.** Click a node and a card
  flies out beside it, glued to the element through pan, zoom and drag. Cards
  are type-aware and tiered: the fields that type actually uses up front, the
  rest behind *extra settings*, foreign fields hidden entirely.
- **Check panel** with a live badge. **MUST FIX** (validator errors) and **TO
  FINISH** (gap questions) grouped *by graph element*, every row click-jumps
  to the node or edge it's about.
- **Readiness cockpit** in the status bar — `captured n/m · bound n/m ·
  checks n (k drafts)`; captured sessions wear a `✓rec` chip; draft checks
  carry a confirm-once button.
- **Save straight into the project.** Served, *save ▾* writes
  `projects/<p>/graphs/<id>.graph.json` through the dev server — validated
  first, atomic, overwrite only on confirmation — and the library refreshes.
  Browser-local saves remain for offline work.
- **Editable env wiring.** The card names the **login** a role uses (and
  who else shares it). Rename a credential's env *variable name* right there
  (`SF_SALES_USERNAME` → `SFDC_UAT_USERNAME`) — the dev server validates it
  and atomically rewrites the account in `personas.json`, so every role on
  that login follows. Your `.env` is never touched. Credential dots go
  green/red from a booleans-only endpoint.
- **Self-explaining canvas** — every node and edge type describes itself on
  hover, plus a dismissible legend and a typed `add ▾` palette with readable
  ids (`db_1`, `api_1`, `sess_1`).

**Planner v2 (preview): `npm run planner:v2`.** The same graph, read as a
numbered *script* — `as <role> on <system> at <url>`, then one line per step
with its record, port and checks — beside a lane canvas that draws the same
document. The library rail lists every project's graphs with a readiness dot
and a record ledger you can click to filter by record; the check strip at the
top replaces the badge and the issues panel. It builds to the same
`tools/journey-planner.html` and keeps the whole `window.planner` API, so both
planners drive one model. It replaces `npm run planner` in sprint 4.

### Getting a graph without drawing one

- **import cases** (planner button, dev server) — an Azure DevOps export
  (`.xlsx` from Test Plans "Export to Excel", or `.csv`) goes into a project
  you pick or create: the file is stored verbatim under
  `projects/<p>/imports/` with a manifest, you tick the test cases, and each
  becomes a draft graph in `projects/<p>/graphs/`. Cases you skip stay in the
  stored import for next time. The AI review of the drafts is *your* step —
  point any model at the graph files.
- **`npm run ado:import`** — the same mapping from the CLI
  (`ADO_FILE=<xlsx|csv>` or pasted text): roles → sessions, steps → `does`
  edges (verb → data port), expected results → draft oracles. Every
  inference is flagged; it never clobbers an existing graph.
- **Capture-first** — `PIPELINE_GRAPH=1 npm run pipeline` turns one recording
  into a compact session→does→data graph with post-save redirects folded in,
  SObjects inferred, and draft oracles marked `draft?`.
- **The graph spec + an AI-facing skill** — `docs/GRAPH-SPEC.md` is the
  normative contract (types, rules, ports, every gap question and its
  write-back op, a complete minimal graph, the "done" checklist), drift-tested
  against the code. `skills/graph-author/SKILL.md` hands it to any AI agent
  together with the import → draft → grill → capture workflow, so an
  external model can complete graphs correctly without bypassing the validator.
- **`npm run grillme`** — the gap engine reads a draft graph and emits every
  hole as an answerable multiple-choice question (12 gap kinds), with 11
  validated write-back operations that apply your answers. Runs as a CLI or
  through the `/grillme` skill.
- **`npm run doctor`** — `GRAPH_DOCTOR=<id|all>`: per-graph ✓/✗ for the org
  URL, every site URL and every persona, plus the exact `.env` skeleton to
  paste.

### Record once, replay forever

- **The pipeline** — `npm run record` opens a headed session as a chosen
  persona (close the window to finish) → a **version-pinned** trace reader →
  the distiller (starter grammar, settle attribution, name-me flags) → the
  generator, which emits journey JSON, a *working* vocabulary step module and
  timing baselines. `npm run pipeline` stitches it, and the real runner
  replays the generated journey verbatim.
- **Identity data is auto-parameterized** — unique per run, `@e2e.invalid`
  emails. Two runs never collide.
- **Multi-actor stitching** — one recording per persona, stitched on wall
  clock, with cross-actor shared identifiers flagged (`PIPELINE_ALIASES=…`).
- **Denial captures** — `RECORD_EXPECT_DENIAL=1` records what a role must
  *not* be able to do, and a captured **success** refuses to generate a denial
  test.

### Running — multi-actor by design

- **Cast**: one browser context per persona per system, several personas alive
  at once. `as()` caches logins (~100ms), `release()` logs out, `deny()` probes
  a capability through **both** the UI and the API — no vacuous denials.
- **Auth ladder** — stored session state → token injection (frontdoor / UI
  Bridge) → a real UI login → an error message that names the exact `.env`
  line you're missing.
- **MFA answered automatically** — zero-dependency RFC 6238 TOTP (verified
  against the spec's Appendix B vectors, sha1/sha256/sha512). The secret in
  `.env` may be raw base32 *or* the enrollment screen's full `otpauth://` URL.
  The challenge handler is implementation-agnostic and selectors are
  overridable.
- **Session policies are enforced, not remembered** — Siebel's
  one-session-at-a-time is a `maxConcurrent` policy; the Cast evicts by
  logging out (LRU) and keeps an audit trail.

### Assertions that fit real systems

- **Four oracle families** — `ui.*` (visible / text / toast / url) watch the
  screen; `api.*` (record_exists / field_equals) ask Salesforce; `db.query`
  and `log.traffic` ask a queryable database or a log system.
- **Backend checks poll.** `timeoutMs` / `pollMs` per check, because async
  integrations settle in their own time. A throw stops precisely; a `false`
  retries to the deadline.
- **Unbound backend oracles report *skipped*, never *passed*** — a check with
  no adapter behind it can't quietly go green.
- **Performance baselines** — p95 × 1.5 soft-flags, p95 × 3 fails fast, plus
  hard `maxDurationMs` ceilings. The runner reads
  `journeys/baselines/<id>.baselines.json` when the capture pipeline has
  written one, and a fully green run folds its durations back into the
  window — the bar tracks the process instead of ageing out.

### Test data

- Faker-backed factory, find-or-create seeding, and ordered dependencies with
  `{unique:}` / `{ref:x.y}` / `{runId}` placeholders.
- **`npm run sweep`** finds — and with `SWEEP_DELETE=1` removes — everything
  tagged `E2E-`.

### Secrets discipline

`personas.json` holds roles, the accounts they log in as, and env-var
**names** (derived from the account id) — never values; the validator
rejects anything that smells like a pasted secret, TOTP seeds included. `.env`,
`.auth/` session state and `recordings/` (traces and HAR can embed tokens) are
gitignored. The planner's dev server reports env presence as booleans only —
values never leave your machine.

### The bar this repo holds itself to

- **Tests for everything.** ~338 unit + harness tests. The harness drives
  **real browsers with no org and no `.env`** — you can verify the whole
  machine before you have a single credential. E2E specs self-skip, naming
  the vars they'd need.
- **Full Microsoft TypeScript 5.9 strict baseline** — including
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Zero `any`,
  zero `@ts-ignore`; every `!` in `src/` carries a comment explaining the
  invariant.
- **ESLint** strict-type-checked + stylistic-type-checked, with each carve-out
  commented and justified in `eslint.config.mjs`.
- **CI runs the same three gates you do** — `typecheck`, `lint`, suite — with
  no secrets.
- **L2 knowledge cache** (`L2/`) — the founding strategy document, an atom
  schema and validated encoding batches, so a new test project bootstraps from
  accumulated knowledge rather than from scratch.
- **Labour telemetry** — `npm run labour` prints scaffold→first-green wall
  clock per process, to prove or refute the project's targets.

---

## Status

Honest about where the line is:

| Area | Status |
|---|---|
| Graph model, planner, check/gap engine | **Shipped and tested** |
| Record → distill → generate → replay | **Shipped**, proven end-to-end on a fixture trace |
| Cast, auth ladder, TOTP, session policies | **Shipped and tested** (harness, no org) |
| Oracles incl. `db.query` / `log.traffic` | **Shipped**; DB and log **adapters are a seam you bind** — unbound checks report *skipped* |
| Real-org binding | **Pending** — the e2e specs exist and self-skip; they've not yet been run against a live org |
| ADO import mapping | **Shipped**, validated on fixtures; **not yet validated against a real ADO export** |
| 50% less labour / 50% more automated | **Unmeasured targets.** The telemetry to measure them ships; the numbers don't exist yet |

## The commands

| Command | What it does |
|---|---|
| `npm test` | unit + harness suites (no org needed) |
| `npm run planner` | visual graph planner, live-reload, env-status dots, editable env wiring |
| `npm run planner:v2` | the Journey Script Planner (preview): the same graph as a numbered script — sessions, steps, ports, checks (`tools/journey-planner.html`) |
| `npm run project:new` | `-- <name> [--team "…"]` — scaffold a team-named project under `projects/` (also in the planner: project ▾ → new) |
| `npm run doctor` | `GRAPH_DOCTOR=<id\|project/id\|project:<name>\|all>` — exact `.env` lines between you and a runnable graph |
| `npm run record` | `RECORD_PERSONA=x RECORD_JOURNEY=y` — capture a flow by driving it once |
| `npm run pipeline` | `PIPELINE_JOURNEY=y` — trace → journey + steps (+`PIPELINE_GRAPH=1` for a capture-first graph) |
| `npm run suite` | `SUITE=<suite\|graph:<ref>\|tag:<t>\|project:<p>>` (default `smoke`) — run every graph the selection names, repainting each; suites live in `suites.json` |
| `npm run graph:compose` | `COMPOSE=<host> COMPOSE_WITH=<sub>` — extend one graph with another (sessions merge, chain splices; also planner insert ▾) |
| `npm run simulate` | `SIMULATE=<id>` — no-org dry run: fabricated green report through the real merge-back (`sim_` runId, throwing step placeholders) |
| `npm run ado:import` | `ADO_FILE=<xlsx|csv>` or `ADO_PASTE=<text>` — Azure DevOps test cases → draft graphs (the planner's **import cases** button does this into a project) |
| `npm run grillme` | `GRILLME=<id>` — every gap in a graph as answerable questions |
| `npm run sweep` | find (and with `SWEEP_DELETE=1`, remove) `E2E-` tagged test data |
| `npm run labour` | scaffold→first-green wall clock per process |
| `npm run typecheck` / `npm run lint` | the two static gates CI runs |

## Layout

```
L2/                    knowledge cache — FOUNDING-DOCUMENT.md is the strategy
src/
  auth/                frontdoor + UI Bridge + TOTP (RFC 6238, any authenticator)
  fixtures/            Cast (multi-persona sessions), lightning component fixture
  components/ pages/   Lightning component objects + thin POMs
  journeys/            journey schema, runner (oracles, screenshots), catalog
  graph/               schema, walker, merge-back, capture-first, ADO import, gaps
  pipeline/            trace reader, distiller, generator, stitcher
  data/                faker factory, find-or-create seeding, data dictionary, sweeper
  personas/            personas.json schema/registry (env-var NAMES only) + env doctor
tests/
  unit/  harness/      every helper tested; harness runs real browsers, no org
  e2e/                 real-org specs, env-gated (skip cleanly without .env)
tools/                 planner build + dev server (single-file output committed)
journeys/graphs/       the process graphs — the living plan/test/report artifacts
docs/  HANDOVER.md     designs, studies, and the session-by-session ledger
```

## License & contributing

**AGPL-3.0** — free for personal and professional use. If you distribute a
modified version, or serve one over a network, the license requires your
changes to be open too; and whether the license technically compels you or
not, the ask is the same: **if you improve it, contribute the improvement
back.** See [CONTRIBUTING.md](CONTRIBUTING.md) — the short version is: tests
for everything, three green gates (`typecheck`, `lint`, `npm test`), DCO
sign-off, no secrets.

Copyright (c) 2026 the salesforce_playwright contributors.
