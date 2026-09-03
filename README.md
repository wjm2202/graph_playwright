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
npm run planner               # the Journey Script Planner on http://127.0.0.1:8765
```

To run against a real org: `cp .env.example .env`, fill it (see
[SETUP-REAL-ORG.md](SETUP-REAL-ORG.md)), then let the doctor tell you exactly
what's still missing:

```bash
npx sfpw doctor all           # or: npm run doctor -- all
```

Everything this repo does from a terminal is one command — `sfpw` — with
`--help` on every subcommand and honest exit codes (`0` ok, `1` the answer is
"no", `2` you typed it wrong). The `npm run <name>` aliases below all forward
to it, so `npm run doctor -- all` and `npx sfpw doctor all` are the same
thing; the `--` is npm's, separating its arguments from the command's.

---

## Creating a graph

Two ways in. Both end at the same place: a `.graph.json` in a project, a
check strip reading `0 must fix`, and a capture queue. The rules every graph
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

### Path A — write it as a script

The planner reads a graph as a numbered **script**: one line per session
("who, where"), one indented line per step ("what they do to which record").
You type the lines; ports, catalog names, relations and the login chain are
inferred from them, and the canvas beside the script draws the same document
as lanes. About **18 actions** to a complete first graph:

1. **New graph.** **New ▾ → Blank graph**. One session line appears with the
   cursor in the role field, and `start` / `end` already exist.
2. **Who, where.** Type the role on the line (`Client Associate`), pick the
   system **on**, and type the landing URL **at**
   (`/lightning/o/Account/list` — the list or record page this role starts
   on, which lets captures skip login). A role the roster doesn't know wears
   a *new* pill; you are asked who it logs in as when you save, not now.
3. **Name it.** **⚙ graph** (next to the script title, or on the canvas
   footer): the id (`create_customer`,
   lower_snake_case — it becomes the filename), a title, any suite `tags`,
   and the systems as pills (＋ system opens a form: label, kind, url env,
   *one session max* for a system like Siebel).
4. **Steps.** **+ step** under the session line, then type the verb
   (`create`) and the record (`Customer`). That one line creates the `does`
   edge, the record node (shared by name with every other step that mentions
   it), the catalog name `customer.create` and the SObject guess `Account` —
   all editable on the card, none of them typed twice.
5. **Confirm the port.** The step shows an amber `⇒ produces ?` pill: the
   first touch of a record publishes it, later touches consume it. Click the
   pill to keep the guess, or pick another on the card. Ports are how a
   record's id reaches later steps — including steps in a graph you join in
   later.
6. **What must be true.** Click the step, then **+ check** on its card:
   `api.record_exists` / `api.field_equals` (SObject, `Field=Value`),
   `ui.toast` / `ui.text` / `ui.url`, or `db.query` / `log.traffic` — the
   last two offer the db / log systems this graph declares and create one if
   it doesn't. A check is scoped `after` the step that causes it, and
   backend checks on async integrations carry a polling budget.
7. **What must be refused.** **+ must not** gives a `denied` line: verb plus
   record again (`delete Customer`), and the capability `customer.delete` is
   derived from it. This is the security half of the test.
8. **More roles.** **+ session** appends the next lane and chains the login
   order behind it. Steps under it that name `Customer` land on the *same*
   record node — that node is the join between the roles.
9. **Fix next.** The check strip at the top counts **must fix** (the
   validator, the login chain and the data flow — the referees the runner
   itself uses), **to finish** (open questions) and **hints**. **Fix next →**
   selects the line the next problem lives on and says what it wants. Keep
   going until it reads `0 must fix · 0 to finish` and the button becomes
   **Run this graph**. `⌘Z` undoes any edit, not just structural ones.
10. **Record.** **● record** on the lane (or on the line) starts
    `sfpw record` as that session's persona through the dev server: a
    headed browser opens, you drive the flow once, and the lane goes
    *recording… → ✓ recorded*. Missing credentials are named with the exact
    `.env` lines to paste; the terminal equivalent is under a disclosure on
    the card.
11. **Save into the project.** A graph belongs to a project —
    **New ▾ → ＋ New project…** scaffolds `projects/crm/` (`graphs/`,
    `imports/`, `evidence/`, `steps/`…) if you don't have one yet, the same
    scaffolder as `npm run project:new`. Then **Save to project** (or
    **Save to…** to pick another). The dev server validates and writes
    `projects/crm/graphs/create_customer.graph.json` (asking before it
    overwrites), and the library rail refreshes. Roles that aren't in
    `personas.json` yet are collected here: pick a new login or an existing
    account per role, and the save writes `personas.json` plus one `.env`
    block per new login. **Export JSON** downloads the file instead, for
    `file://` use.
12. **Run.** `npx sfpw suite graph:crm/create_customer` — one generic
    spec walks whatever the suite selects, and every run repaints the graph
    (pass/fail borders, timings, check dots). Put the graph in `suites.json`
    or give it a `tags` entry to make it part of a standing suite.

Other doors into the same script: **New ▾ → Paste a script** takes the
grammar above as text (what an AI, or a test case, can write:
`as <Role> on <System> at <url>` / `<verb> <Record> (<SObject>)` /
`✓ <kind> <target> <value>` / `must not <verb> <Record>`), and **Export →
Copy as script** hands it back, naming anything the text cannot carry.

Extending a flow: **Join another graph…** splices the other graph in —
sessions merge on system + role, records merge by name, and the `after` is
inferred, so there is no seam to draw by hand. If the merge is refused (two
graphs defining one system differently, say), the refusal names the fix and
offers to insert as an island instead.

### Path B — import test cases from Azure DevOps (Excel)

1. **Export from ADO.** Either
   *Test Plans → your suite → ⋯ → Export test cases → Excel* (one row per
   step: `ID · Work Item Type · Title · Test Step · Step Action · Step
   Expected`), or *Queries → your query → Export to CSV* with the **Steps**
   column included. Both layouts are recognised; keep the **Title** column.
   Write the steps ADO-style — `As <role>, <action>` with an expected result
   — and the importer gets the roles, records and checks right.
2. **Planner → New ▾ → From an ADO export** (dev server only).
3. **Project.** Pick an existing project or `＋ new project…` and name it.
   The file will be stored under that project.
4. **File.** Choose the `.xlsx` / `.csv`, click **read test cases**. The file
   is copied verbatim to `projects/<p>/imports/<stamp>-<name>.xlsx` next to
   a manifest, then parsed.
5. **Pick.** Every test case is listed with its step count, ticked by
   default. Untick what you don't want now — it stays in the stored import
   for later (*previous imports in this project* re-opens it, no re-upload).
6. **Import selected.** One draft graph per case lands in
   `projects/<p>/graphs/<slug-of-title>.graph.json`; the results list names
   every graph with an **open** button, and the planner lands on the first.
7. **Understand what you got.** `As admin, …` → a session bound to alias
   `admin`; each step → a `does` edge named `<object>.<verb>`; nouns the
   expected result says were created/saved → data nodes; the verb → a *draft*
   port; the expected text → a *draft* check. Every guess is flagged.
8. **Complete each graph.** Open it and work the check strip's **Fix next →**
   through the *to finish* questions (bind roles, confirm or drop each
   `draft?` check, confirm ports, session policy, URLs). Or from a terminal:
   `npx sfpw grillme <p>/<id>` lists the same questions (`--json` prints them
   as an array and nothing else); answers go back as a JSON ops file with
   `sfpw grillme <p>/<id> --apply ops.json`. Point your own AI at
   `skills/graph-author/SKILL.md` and it will run this loop with you.
9. **Capture and run** — as in Path A steps 10–12.

CLI equivalent of steps 2–6: `npx sfpw import export.xlsx` (writes to
`journeys/graphs/`), or `sfpw import export.xlsx --project crm` to keep the
export as a project asset and land the drafts in `projects/crm/graphs/`.

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
- **One authoring form, old files still open.** `process-graph/2` is the
  only shape the validator, the walker and the planner know. Every load door
  runs the same two conversions first: `upgradeGraph()` turns a
  `process-graph/1` file into v2, and `normalizeGraph()` maps retired
  data-flow fields (`origin`, `ref`, `data.bind`) forward, warning on stderr
  and naming the node. Nothing is rewritten on disk until you save.
- **Merge-back.** A run's results are merged onto the graph it came from —
  every node paints pass/fail with its duration and the screenshot the run
  captured. The screenshots are FILES, under the graph's own
  `evidence/<graph_id>/<runId>/` folder, and the node keeps a short relative
  ref: a repainted graph stays a diff you can read (`node
  tools/migrate-evidence.mjs <graph.json>` moves an older graph's inline
  images out).
- **Suites, not generated specs.** `suites.json` names selections — explicit
  `graphs`, a graph `tags` list, or a whole `project` — and ONE spec
  (`tests/e2e/graphs.spec.ts`) runs whatever the selection names, one test per
  graph × persona-matrix binding. `npx sfpw suite smoke`; nothing is
  code-generated, so a graph joins a suite by being tagged.

### Authoring — the Journey Script Planner

`npm run planner` serves the planner on http://127.0.0.1:8765 — one
self-contained file (`tools/planner.html`, built from `tools/planner-v2/`)
with auto-rebuild and live reload while you develop it. It edits the *same*
`ProcessGraph` the runner runs: there is no planner format.

- **The script IS the graph.** A numbered script — `as <role> on <system> at
  <url>`, then one line per step with its verb, record, port and checks —
  where the line numbers are the run order the walker will take. Typing a
  record name creates the record node; a second line naming it joins to the
  same node. Ports (`⇒ produces` / `⇐ consumes` / `⇄ updates`), catalog names
  (`<record>.<verb>`), relations and denial capabilities are **inferred** and
  shown as amber drafts until you confirm them. Nothing is typed twice, and
  nothing that the tool can work out is asked — which is why a first graph is
  about eighteen actions.
- **A canvas that draws the same document.** Cytoscape + dagre beside the
  script: sessions are compound **lanes** in chain order, steps are their
  children, records hang in the column of the lane that first touches them.
  Drag to reposition (saved as `pos`), shift-drag to connect (the relation is
  inferred from the endpoints, with a *does / must not* choice on drop),
  SPACE-drag to box-select and move a group, double-click empty canvas for the
  next session. Pan and zoom survive every edit — the canvas patches, it never
  rebuilds under your hands.
- **Cards, not a side panel.** Click a line, a lane or a record and a card
  flies out beside it, glued through pan, zoom and drag, showing only what
  that kind uses: the session card has role, persona, *logs in as*, auth,
  system, landing URL and the credential rows; the step card has verb,
  record, SObject, catalog, port, checks, evidence sources and
  *replicated to →*; the ⚙ graph card has id, title, tags and the systems.
- **One check strip** instead of a badge and a panel: **must fix** (the
  validator, the login chain and the data flow — the same referees the
  runner uses), **to finish**, **hints**, **captured n/m**, and one verb —
  **Fix next →**, which selects the line the problem lives on, or **Run this
  graph** once nothing is open.
- **● record on the lane.** Starts `sfpw record` as that session's persona
  through the dev server, streams the output, and flips the lane to
  *✓ recorded*; missing credentials come back as the `.env` lines to paste.
- **Editable env wiring.** The card names the **login** a role uses (and who
  else shares it). Rename a credential's env *variable name* right there
  (`SF_SALES_USERNAME` → `SFDC_UAT_USERNAME`) — the dev server validates it
  and atomically rewrites the account in `personas.json`, so every role on
  that login follows. Your `.env` is never touched; presence dots come from a
  booleans-only endpoint.
- **A library rail** listing every project's graphs with a readiness dot, a
  record ledger you can click to filter the library by record, and the
  suites from `suites.json` with the `sfpw suite` line to run them.
- **Doors in and out.** **New ▾** — blank, paste a script, an ADO export, a
  recording, open a `.graph.json`, ＋ new project. **Join another graph…**
  splices rather than dumping an island. **Export JSON** copies or downloads,
  and *Copy as script* hands the text back. **View** makes it read-only for
  sharing a repainted graph; `⌘Z` undoes any edit.
- **Self-explaining.** Every pill, lane and button has a hover title, and `?`
  opens the legend.

### Getting a graph without drawing one

- **New ▾ → From an ADO export** (planner, dev server) — an Azure DevOps export
  (`.xlsx` from Test Plans "Export to Excel", or `.csv`) goes into a project
  you pick or create: the file is stored verbatim under
  `projects/<p>/imports/` with a manifest, you tick the test cases, and each
  becomes a draft graph in `projects/<p>/graphs/`. Cases you skip stay in the
  stored import for next time. The AI review of the drafts is *your* step —
  point any model at the graph files.
- **`sfpw import <file.xlsx|.csv>`** — the same mapping from the CLI
  (`--paste <file.txt>` for pasted text): roles → sessions, steps → `does`
  edges (verb → data port), expected results → draft oracles. Every
  inference is flagged; it never clobbers an existing graph.
- **Capture-first** — `sfpw pipeline <journey> --graph` turns one recording
  into a compact session→does→data graph with post-save redirects folded in,
  SObjects inferred, and draft oracles marked `draft?`.
- **The graph spec + an AI-facing skill** — `docs/GRAPH-SPEC.md` is the
  normative contract (types, rules, ports, every gap question and its
  write-back op, a complete minimal graph, the "done" checklist), drift-tested
  against the code. `skills/graph-author/SKILL.md` hands it to any AI agent
  together with the import → draft → grill → capture workflow, so an
  external model can complete graphs correctly without bypassing the validator.
- **`sfpw grillme <ref>`** — the gap engine reads a draft graph and emits every
  hole as an answerable multiple-choice question (8 gap kinds), with 8
  validated write-back operations that apply your answers (`--apply ops.json`).
  Advice that has no answer (a missing landing URL, a state with nothing to
  check, no must-NOT case) is printed separately as hints, never as work.
  `--json` prints the questions as an array and nothing else — the contract
  the `/grillme` skill parses.
- **`sfpw doctor [<id>|all]`** — per-graph ✓/✗ for the org
  URL, every site URL and every persona, plus the exact `.env` skeleton to
  paste.

### Record once, replay forever

- **The pipeline** — `sfpw record <persona> <journey>` opens a headed session as a chosen
  persona (close the window to finish) → a **version-pinned** trace reader →
  the distiller (starter grammar, settle attribution, name-me flags) → the
  generator, which emits journey JSON, a *working* vocabulary step module and
  timing baselines. `sfpw pipeline <journey>` stitches it, and the real runner
  replays the generated journey verbatim.
- **Identity data is auto-parameterized** — unique per run, `@e2e.invalid`
  emails. Two runs never collide.
- **Multi-actor stitching** — one recording per persona, stitched on wall
  clock, with cross-actor shared identifiers flagged (`--aliases a=b,…`).
- **Denial captures** — `sfpw record <persona> <journey> --expect-denial`
  records what a role must *not* be able to do, and a captured **success**
  refuses to generate a denial test.

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
- **`sfpw sweep`** finds — and with `--delete` removes — everything
  tagged `E2E-`.

### Secrets discipline

`personas.json` holds roles, the accounts they log in as, and env-var
**names** (derived from the account id) — never values; the validator
rejects anything that smells like a pasted secret, TOTP seeds included. `.env`,
`.auth/` session state and `recordings/` (traces and HAR can embed tokens) are
gitignored. The planner's dev server reports env presence as booleans only —
values never leave your machine.

### The bar this repo holds itself to

- **Tests for everything.** Some 690 unit + harness tests, run at several
  worker counts so nothing depends on order. The harness drives
  **real browsers with no org and no `.env`** — you can verify the whole
  machine before you have a single credential. E2E specs self-skip, naming
  the vars they'd need.
- **Full Microsoft TypeScript 5.9 strict baseline** — including
  `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. Zero `any`,
  zero `@ts-ignore`; every `!` in `src/` carries a comment explaining the
  invariant.
- **ESLint** strict-type-checked + stylistic-type-checked, with each carve-out
  commented and justified in `eslint.config.mjs`.
- **CI runs the same three gates you do** — `typecheck`, `lint`, `npm test`
  — with no secrets and no browser-driven command specs: everything that can
  be a plain Node exit code is one.
- **A written record** — `L2/FOUNDING-DOCUMENT.md` is the strategy,
  `docs/` holds the designs and studies with their status, and
  [docs/README.md](docs/README.md) says which of them are normative today.
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

One binary, `sfpw` (`bin/sfpw.mjs`), with `--help` on every subcommand.
Exit codes are the contract: **0** it worked, **1** the honest answer is "no"
(not ready, nothing to process, a run failed), **2** you used it wrong.
Errors go to stderr; with `--json`, stdout carries the answer and nothing
else. Run it as `npx sfpw <command>`, or through the `npm run` alias in the
last column (`npm run doctor -- all` — npm needs the `--`).

| Command | What it does | npm alias |
|---|---|---|
| `sfpw doctor [<ref>\|all\|project:<p>]` | exact `.env` lines between you and a runnable graph; exit 1 while anything is missing | `npm run doctor` |
| `sfpw grillme <ref> [--apply <ops.json>] [--json]` | every gap in a graph as answerable questions; `--json` prints only the array | `npm run grillme` |
| `sfpw compose <host> <sub> [--after <session>] [--island]` | extend one graph with another (island by default; `--after` splices) | `npm run graph:compose` |
| `sfpw import <file.xlsx\|.csv> [--project <p>]` · `sfpw import --paste <file.txt>` | Azure DevOps test cases → draft graphs (the planner's **New ▾ → From an ADO export** does this into a project) | `npm run ado:import` |
| `sfpw pipeline <journey> [--aliases a=b,…] [--capability <c>] [--graph] [--overwrite]` | trace → journey + steps (+ a capture-first graph) | `npm run pipeline` |
| `sfpw contracts <journey> [--out <dir>]` | harvest the recording's MMPM settle-contract atoms into one review-only batch (never published; off unless asked) | — |
| `sfpw sweep [--delete] [--targets …] [--patterns …]` | find (and with `--delete`, remove) `E2E`-named test data | `npm run sweep` |
| `sfpw suite [<spec>] [playwright args…]` | run every graph the selection names (`<suite>`, `graph:<ref>`, `tag:<t>`, `project:<p>`; default `smoke`), repainting each | `npm run suite` |
| `sfpw record <persona> <journey> [--expect-denial]` | capture a flow by driving it once (headed browser) | `npm run record` |
| `sfpw simulate <ref> [--overwrite]` | no-org dry run: fabricated green report through the real merge-back (`sim_` runId, throwing step placeholders) | `npm run simulate` |
| `sfpw fixture:trace` / `sfpw fixture:artifacts` | regenerate the committed test fixtures (maintainers, on a Playwright upgrade) | — |

`record`, `simulate` and the two fixture generators delegate to Playwright —
they are the only things here that need a browser. Everything else is plain
Node, so it has a real exit code and does not rewrite `playwright-report/`.

The rest is still npm:

| Command | What it does |
|---|---|
| `npm test` | unit + harness suites (no org needed) |
| `npm run planner` | the Journey Script Planner — the graph as a numbered script beside a lane canvas; live-reload, env-status dots, editable env wiring (`tools/planner.html`) |
| `npm run build:planner` | rebuild that single file from `tools/planner-v2/` (a maintainer step; the output is committed) |
| `npm run project:new` | `-- <name> [--team "…"]` — scaffold a team-named project under `projects/` (also in the planner: New ▾ → ＋ new project…) |
| `npm run labour` | scaffold→first-green wall clock per process |
| `npm run typecheck` / `npm run lint` | the two static gates CI runs |

## Layout

```
L2/                    knowledge cache — FOUNDING-DOCUMENT.md is the strategy
bin/sfpw.mjs           the one command line; each subcommand is a thin module in src/cli/
suites.json            named selections of graphs (explicit refs, tags, or a whole project)
src/
  cli/                 sfpw subcommands: parse → call the module below → print, exit code
  auth/                frontdoor + UI Bridge + TOTP (RFC 6238, any authenticator)
  fixtures/            Cast (multi-persona sessions), lightning component fixture
  components/ pages/   Lightning component objects + thin POMs
  journeys/            journey schema, runner (oracles, screenshots), catalog
  graph/               schema, walker, merge-back, capture-first, ADO import, gaps,
                       the script codec (script.ts) and the inference rules (infer.ts)
  pipeline/            trace reader, distiller, generator, stitcher
  data/                faker factory, find-or-create seeding, data dictionary, sweeper
  personas/            personas.json schema/registry (env-var NAMES only) + env doctor
tests/
  unit/  harness/      every helper tested; harness runs real browsers, no org
  e2e/                 real-org specs, env-gated (skip cleanly without .env)
tools/
  planner-v2/          the planner's source: index.html, style.css, js/*.js (one IIFE per module)
  build-planner.mjs    inlines the libraries + the shared src/graph modules → tools/planner.html (committed)
  serve-planner.mjs    the dev server: the planner at /, the /__ routes, live reload
journeys/graphs/       the process graphs — the living plan/test/report artifacts
journeys/evidence/     their run screenshots, `<graph_id>/<runId>/<node>.jpg` (a
                       project graph's live in projects/<p>/evidence/ instead)
projects/<name>/       a team's graphs, imports, evidence and recordings (gitignored: customer work)
docs/                  designs, studies and specs — docs/README.md is the map
HANDOVER.md            the session-by-session ledger, newest first
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
