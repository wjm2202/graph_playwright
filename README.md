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
- **Versioned schema.** `process-graph/2` with a superset validator (v1 graphs
  keep loading) and an `upgradeGraph()` v1→v2 converter.
- **Merge-back.** A run's results are merged onto the graph it came from —
  every node paints pass/fail with its duration and the screenshot the run
  captured.
- **Mermaid export** for embedding a process in any doc.

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
- **Editable env wiring.** Rename a credential's env *variable name* right on
  the card (`SF_SALES_USERNAME` → `SFDC_UAT_USERNAME`) — the dev server
  validates it and atomically rewrites `personas.json`. Your `.env` is never
  touched. Credential dots go green/red from a booleans-only endpoint.
- **Self-explaining canvas** — every node and edge type describes itself on
  hover, plus a dismissible legend and a typed `add ▾` palette with readable
  ids (`db_1`, `api_1`, `sess_1`).

### Getting a graph without drawing one

- **`npm run ado:import`** — an Azure DevOps test case (CSV file or pasted
  text) becomes a draft graph: roles → sessions, steps → `does` edges,
  expected results → draft oracles. Every inference is flagged; it never
  clobbers an existing graph.
- **Capture-first** — `PIPELINE_GRAPH=1 npm run pipeline` turns one recording
  into a compact session→does→data graph with post-save redirects folded in,
  SObjects inferred, and draft oracles marked `draft?`.
- **`npm run grillme`** — the gap engine reads a draft graph and emits every
  hole as an answerable multiple-choice question (9 gap kinds), with 8
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
  hard `maxDurationMs` ceilings.

### Test data

- Faker-backed factory, find-or-create seeding, and ordered dependencies with
  `{unique:}` / `{ref:x.y}` / `{runId}` placeholders.
- **`npm run sweep`** finds — and with `SWEEP_DELETE=1` removes — everything
  tagged `E2E-`.

### Secrets discipline

`personas.json` holds env-var **names**, never values; the validator rejects
anything that smells like a pasted secret, TOTP seeds included. `.env`,
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
| `npm run doctor` | `GRAPH_DOCTOR=<id\|all>` — exact `.env` lines between you and a runnable graph |
| `npm run record` | `RECORD_PERSONA=x RECORD_JOURNEY=y` — capture a flow by driving it once |
| `npm run pipeline` | `PIPELINE_JOURNEY=y` — trace → journey + steps (+`PIPELINE_GRAPH=1` for a capture-first graph) |
| `npm run graph:spec` | `GRAPH_SPEC=<id>` — emit a standing spec that runs + repaints the graph |
| `npm run ado:import` | `ADO_FILE=<csv>` or `ADO_PASTE=<text>` — Azure DevOps test case → draft graph |
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
