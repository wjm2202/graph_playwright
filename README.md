# salesforce_playwright

Plan-first, multi-actor Playwright testing for Salesforce (and its downstream
systems, e.g. Siebel). Processes are drawn as **graphs** in a visual planner;
runs are recorded once by a human and replayed forever; results paint the
plan green/red with screenshots. Built around an **L2 knowledge cache** so a
new test project bootstraps in hours instead of weeks — targets: 50% less
labour, 50% more automated, 50% more useful.

## How it works — one loop

```
plan graph (planner UI / ADO import / one recording)
   → journey (walker) → run (multi-actor sessions, oracles, screenshots)
   → merge-back (the SAME graph repaints: pass/fail, timings, snapshots)
```

- **Process graphs** (`journeys/graphs/*.graph.json`) — nodes are states
  (sessions, records, checkpoints, plus db / log / api evidence sources);
  edges are relations (*login as*, *does*, *asserts*, *must NOT be able to*).
- **Cast** — one Playwright context per persona per system: token injection
  (frontdoor / UI Bridge) → stored session → one UI login (TOTP/MFA answered
  automatically when `totpEnv` is set). Per-system session policies
  (Siebel's one-session-max) are enforced, not remembered.
- **Recorder pipeline** — record once (`npm run record`), distill the trace,
  generate a replayable journey with identity data auto-parameterized
  (unique per run, `@e2e.invalid` emails — no data collisions, ever).
- **Oracles** — `expects[]` on nodes become assertions: ui.\* watch the
  screen, api.\* ask Salesforce, db.query / log.traffic ask a QUERYABLE
  database or a log system; backend checks poll (async integrations settle
  in their own time).

## Quickstart

```bash
npm install
npx playwright install chromium
npm test                      # unit + harness — green with NO org, no .env
npm run planner               # the visual planner on http://127.0.0.1:8765
```

Then, to run against a real org: `cp .env.example .env`, fill it (see
`SETUP-REAL-ORG.md`), and let the doctor tell you what's missing:

```bash
GRAPH_DOCTOR=all npm run doctor
```

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
| `npm run grillme` | `GRILLME=<id>` — every gap in a graph as answerable questions (the /grillme skill drives this) |
| `npm run sweep` | find (and with `SWEEP_DELETE=1`, remove) `E2E-` tagged test data |
| `npm run labour` | scaffold→first-green wall clock per process |
| `npm run typecheck` | strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + no-unused (Microsoft 5.9 baseline) |

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

## Secrets discipline

`personas.json` holds env-var **names**, never values (the validator rejects
anything that smells like a pasted secret, TOTP seeds included). `.env`,
`.auth/` session state, and `recordings/` (traces + HAR can embed tokens)
are gitignored. The planner's dev server reports env presence as booleans
only; values never leave your machine.

## License & contributing

**AGPL-3.0** — free for personal and professional use. If you distribute a
modified version, or serve one over a network, the license requires your
changes to be open too; and whether the license technically compels you or
not, the ask is the same: **if you improve it, contribute the improvement
back.** See [CONTRIBUTING.md](CONTRIBUTING.md) — the short version is: tests
for everything, three green gates (`typecheck`, `lint`, `npm test`), DCO
sign-off, no secrets.

Copyright (c) 2026 the salesforce_playwright contributors.
