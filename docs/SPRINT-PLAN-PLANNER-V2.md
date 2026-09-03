# Sprint plan — Journey Script Planner (planner v2) and the simplification

> **Status (2026-09-03): complete.** All four sprints shipped and are committed in order; this file is the ledger of what each one delivered and why, kept as written at the time (so early entries name files that later sprints renamed — `journey-planner.html` became `tools/planner.html` in 4.1). The current state of the code is described by the README and [GRAPH-SPEC.md](GRAPH-SPEC.md); [README.md](README.md) here maps the rest of `docs/`.

*Built from `REVIEW-SIMPLIFICATION-2026-09-03.md` (§4 ranked plan, §5 UI) and
`PLANNER-FEATURE-PARITY.md` (the retirement gate). Each sprint is independently
shippable: three green gates (`typecheck`, `lint`, `npm test`) at the end of every
sprint, and nothing in a later sprint is needed for an earlier one to be useful.
Git is human-only — commit after each sprint.*

## Order and why

Foundation before UI: the new planner edits the *same* graph the runner runs, so the
model must be trimmed first (v1 gone, suites in) or the UI would be built against
fields that are about to change. Then the two pure modules the UI needs (script
codec, inference), with the dev-server routes. Then the UI itself, on a stable
model, with the parity table as its checklist. Retirement last.

## Sprint 1 — Foundation (model + run)  ✅ done 2026-09-03 — 536 unit+harness green, tsc + eslint clean, net −567 LOC (39 files, +805/−1372). Not committed (human git).

| # | Deliverable | Files | Tests | Status |
|---|---|---|---|---|
| 1.1 | **Retire v1 authoring.** Remove node types `action` `decision` `snapshot`, edge types `navigates` `deny`, `PNode.catalog`, the v1 branch of the walker, and the dead modules `fromDistillation.ts` `toBatch.ts` `mermaid.ts`. Keep `upgrade.ts` and **call it** on load (`resolve.ts`, planner `load`) so a v1 file still opens — as v2. `runOrder()` stays the planner's walk (unified in 2.2). | `src/graph/schema.ts` `toJourney.ts` `gaps.ts` `compose.ts` `resolve.ts` `toSpec.ts`; delete 3 modules + their specs; `docs/GRAPH-SPEC.md` (drift test) | `graph-schema` `graph-v2` `graph-tojourney` `gaps` `graph-spec` updated; upgrade-on-load test added | done |
| 1.2 | **Suites + one generic runner; baselines wired.** `tags?: string[]` on `ProcessGraph`; `suites.json` (`graphs` / `tags` / `project`); `src/suites.ts` `selectGraphs(spec)`; `tests/e2e/graphs.spec.ts` iterating `selectGraphs × expandVariants → runGraphFile`; `runGraphFile` gets `baselines` from `journeys/baselines/<id>.baselines.json` when present. Delete `toSpec.ts`, `tests/record/make-graph-spec.spec.ts`, `tests/e2e/lead_to_customer.journey.spec.ts`, the `graph:spec` script; add `npm run suite`. | as listed; `package.json`; README commands table; `ci.yml` unchanged (e2e stays env-gated) | `tests/unit/suites.spec.ts` (selection by graphs/tags/project, unknown suite, empty), `graph-spec.spec` trimmed, `close-loop.spec` re-pointed, `readme.spec` green | done |
| 1.3 | Gates + checkpoint | — | `npm run typecheck && npm run lint && npm test` | done |

## Sprint 2 — Script codec, inference, server routes  ✅ done 2026-09-03 — 593 unit+harness green, tsc + eslint clean. New: `src/graph/script.ts` (+19 tests, GRAPH-SPEC §13), `src/graph/infer.ts` (+21 tests; `runOrder` is now the single walk), `src/personas/wiring.ts` (+12 tests; one slug), `/__library` + `/__record` (+4 route tests; graph save no longer rebuilds/reloads). Not committed (human git). Known gaps: `replicated to` (handoff) line not in the script grammar; `infer.ts` not yet consumed by the old planner UI (Sprint 3).

| # | Deliverable | Files | Tests |
|---|---|---|---|
| 2.1 | **`script.ts`** — `parseScript(text) → ProcessGraph` and `printScript(graph) → text` for the grammar in review §5.1 (`as <Role> on <System> at <url>` / `<verb> <Record> (<SObject>)` / `✓ <kind> <target> <value>` / `must not <verb> <Record>` / `after` implied by nesting). Shared parsing helpers lifted from `fromAdo.ts` (`objectOf`, `verbIo`). | `src/graph/script.ts`; `fromAdo.ts` exports helpers | round-trip on the four shipped graphs (parse(print(g)) ≡ g modulo ids/pos), grammar cases, error messages with line numbers |
| 2.2 | **`infer.ts`** — `inferPorts(graph)` first-touch ports with `ioDraft`, `catalogFor(edge)`, `relationFor(fromType, toType)`, `sessionLabel(node)`; `runOrder` becomes the single walk used by `toJourneyV2`. | `src/graph/infer.ts` `toJourney.ts` `compose.ts` | unit tests per function; parity test that `toJourneyV2` order equals `runOrder` |
| 2.3 | **Dev server** — `GET /__library` (graphs + projects as JSON, no rebuild), `POST /__record` (spawn `npm run record` as persona/journey, SSE progress, re-read `steps.status`), `POST /__graphs` no longer triggers a rebuild/reload. Move `addPersonas`, env-wiring and the slug into `src/personas/` (one implementation). | `tools/serve-planner.mjs` `src/personas/wiring.ts` | `serve-planner.spec` route tests; `personas.spec` wiring tests |

## Sprint 3 — The new planner (UI), from the prototype on the real model

*3.1 done 2026-09-03 — 615 unit+harness green, tsc + eslint clean. Source is
`tools/planner-v2/` (index.html + style.css + 12 IIFE modules ordered by
`modules.json`, one `window.P2` namespace), built by `buildV2()` into
`tools/journey-planner.html` (`npm run planner:v2`, or `PLANNER_V2=1`). The
model is the ProcessGraph: `view.js` projects it, `ops.js` is the ONLY writer
(validate-or-rollback + undo per op), `canvas.js` and `sheets.js` are hooked
stubs for 3.2/3.3. `src/graph/script.ts` now rides along as
`window.ProcessGraphScript`. `/__library` grew a `suites` key. Not committed
(human git).*

*3.2 done 2026-09-03 — the canvas is `tools/planner-v2/js/canvas.js` on
cytoscape + dagre + edgehandles, mounted ONCE into `#cy` and diff-rendered
(`cy.batch`, matched by id) so pan, zoom and the selection survive every edit.
Sessions are compound lanes, steps their children, records the shared nodes
below; ports colour the step→record edges. Gestures: drag → `setLayoutPos`
(lane `pos` = the lane origin), shift-drag → edgehandles with the relation
from `infer.relationFor` and a `does / must not` popover on drop, lane→lane
re-chains through the new `P2.ops.moveSessionAfter`, lane→empty adds the next
session, SPACE-drag box select with the ported `#groupbox` grip, `dbltap`
empty → a new session, `dbltap` a lane / the ● overlay → record, hover tips,
run paint. `tests/harness/planner-v2-canvas.spec.ts` (29 tests) covers every
parity §6 row and fails if one is still `○`. Not committed (human git).*

*3.3 done 2026-09-03 — the sheets. `sheets.js` (machinery + New ▾ routing,
paste-a-script, join, export/copy-as-script, open-a-file, missing
credentials) and the new `sheets-server.js` (ADO import wizard, from-a-
recording, ＋ new project, save-to-another-project, the personas "logs in as"
step on save), both IIFEs registered into one `#sheet` overlay; Esc, the
backdrop and every Cancel close it, and `close()` releases the live reload the
server parked while a wizard was up. New: `GET /__recordings`,
`ops.setSystemDef` (the composer's "align the definitions" fix),
`loadDoc(…, {dirty:true})` for drafts, a top-bar **Save to…**, a New ▾ **＋
New project…**. Tests: `tests/harness/planner-v2-sheets.spec.ts` (12) + a
`/__recordings` route test. Parity §1 §2 §7 rows ticked in the v2 column. Not
committed (human git).*

*3.4 done 2026-09-03 — 689 unit+harness green (was 657), tsc + eslint clean.
Three strands. **(a) The canvas, on the owner's own drive of the real
`lead_to_customer` graph.** A `ResizeObserver` on `#cy` re-fits once per SIZE
change (the split pane was drawing at the canvas tab's width and clipping),
and opening a document re-fits too, while an edit never steals the human's pan
and zoom. `grid()` now hangs every record in the COLUMN of the lane that first
touches it (`infer.inferPorts`' own rule) with infra under the column — one
shared record row was why every step→record edge crossed the whole drawing.
Step→record edges are `taxi`, and edge labels appear only on hover or
selection. The palette is read off `style.css`'s tokens at mount (a light-mode
canvas on a dark panel was the "small grey boxes" the owner saw), lane padding
reserves a real header strip, and the boxes are sized to be legible at the
default fit. **(b) The last six parity `○` rows**: evidence sources
(`ops.addInfraNode` / `setInfraField` — a `db.query` or `log.traffic` check now
picks or creates its database / log system, with the `touches` edge written in
the same transaction), `replicated to →` (`ops.addHandoff`, method + path), the
`lastResult` dot on every check pill and card row, the snapshot thumbnail and
manual attach (`ops.setSnapshot`), notes through `ops.setNotes`, and the
read-only capture chips. The ledger is one line per record with `↑ n · ↓ m` and
clicking it filters the library. **(c) The old suite, ported**:
`planner-v2-cards` (16), `planner-v2-compose` (5), `planner-v2-order-health`
(4), `planner-v2-projects` (7); group and import-cases were already covered by
the canvas and sheets specs (the map is in parity §9). One real bug fell out:
`run()` rendered synchronously AND the bus scheduled a second render a frame
later, which rebuilt the card under whoever was typing into it — `schedule()`
now drops the redundant pass. Not committed (human git).*

| # | Deliverable | Parity rows |
|---|---|---|
| 3.1 | Shell: top bar, check strip + Fix next, library rail, script editor (lines, pills, checks), node cards (session / step / graph) with editable env names and ● record; load/save through `/__library` `/__graphs` `/__personas`; `window.planner` API kept. New file `tools/planner-v2-src.html` built by `build-planner.mjs` into `tools/journey-planner.html`. | §1 §3 §4 rows marked ✓ |
| 3.2 | Canvas on cytoscape: lanes/records rendering from the document, drag + `pos`, edgehandles with inferred relation, box select + group move, dbltap, pan/zoom, hover titles, ● record on lanes, run paint. | §6 rows |
| 3.3 | Sheets: New ▾ (blank / paste script / ADO import / recording / open file), Join, Export/Download, new project, personas "logs in as". | §1 §2 rows |
| 3.4 | Undo, view mode, legend, snapshot attach, system form, Delete key; harness specs `tests/harness/planner-v2-*.spec.ts` (one per pane) + the existing `planner*.spec.ts` ported. | every `todo` row → ✓ — **done**: no `○` left in the parity v2 column |

## Sprint 4 — Retire and polish

*4.1 done 2026-09-03 — **v2 IS the planner; v1 is gone.** Deleted
`tools/planner-src.html`, `tools/process-planner.html`, `buildV1`, the
`planner:v2` script and the `PLANNER_V2` flag, the two v1 review drivers, and
the six old harness specs. The build output is now `tools/planner.html`
(`npm run build:planner` unchanged); `npm run planner` serves it at `/` and
by name, and `/process-planner.html` + `/journey-planner.html` **301** to it.
`tools/persona-wiring.mjs` is KEPT (both the build and the server use it to
shape personas.json for the page — `src/personas/wiring.ts` is the mutation
half: addPersonas / renameEnvName), with a comment saying so. The seven v2
harness specs dropped their `-v2-` qualifier; before deleting the old ones,
five behaviours with no equivalent were ported — the load-door refusal, the
run command + the strip's one verb, the `?` legend (→ `planner-shell`), the
`ef_auth` picker now on the session card (→ `planner-cards`), and the
credential env rename against a real server (→ `planner-sheets`, served) —
plus a new route test for the 301s. `tests/unit/planner-parity.spec.ts` now
extracts from `tools/planner-v2/index.html` + `js/*.js` +
`serve-planner.mjs` and requires every control, New ▾ entry, canvas event,
route and `window.planner` name to be named in PARITY.md (new §10 indexes the
live surface); it also holds the retirement (v1 files stay deleted, no `○`
returns) and no longer tests the prototype, which is kept as design history.
`tests/unit/build-planner-v2.spec.ts` → `build-planner.spec.ts`. Docs:
README (Path A rewritten script-first ≈18 actions, the Authoring section
rewritten from the parity v2 column, one `planner` command, the layout tree),
GRAPH-SPEC §2/§8/§10/§12, the graph-author skill, CONTRIBUTING, the PR
template, PARITY preface + §9 + §10, HANDOVER. Suite: **621 unit+harness
green at 8 workers AND at 4** (was 689 — the six old specs took 74 tests with
them; 6 new ones landed: the five ports plus a route test for the 301s).
Not committed (human git).*

*4.2 done 2026-09-03 — **evidence lives in files; graphs stay readable.**
`src/graph/evidence.ts` is the one layout rule: a graph's ROOT is its folder,
or that folder's parent when the folder is `graphs`, so evidence lands in
`<root>/evidence/<graph_id>/<runId>/<node_id>.jpg` — `projects/<p>/evidence/`
for a project graph, `journeys/evidence/` for a legacy flat one — and the
node stores the path RELATIVE to that root
(`evidence/<id>/<runId>/<node>.jpg`), so a project folder travels with its
paint. `mergeRunIntoGraph` takes an `evidenceDir` and writes the file
(`runGraphFile` derives it from where the graph lives; `simulateRun` passes
it too, `sim_` runId and all). With no `evidenceDir` — `runGraph` on an
in-memory graph — the legacy inline data URL is still produced, and old
graphs with `data:` refs open everywhere and migrate on the next merge-back.
The planner resolves a ref through `P2.net.evidenceUrl`: served, `GET
/__evidence?ref=<graph ref>&file=<rel>` (path-traversal-safe — anything
resolving outside that graph's evidence folder is a 403, unknown graph or
missing file a 404); over `file://` the card NAMES the file instead of
showing a broken image. The manual attach is untouched (still a data URL — a
hand-picked reference is not run evidence). `tools/migrate-evidence.mjs`
(idempotent, `--dry-run`, reusable on customers' graphs) moved the shipped
`lead_to_customer` graph's six inline JPEGs to
`journeys/evidence/lead_to_customer/sim_mthrf41j/`: **91 KB → 12 KB**. Those
six (≈70 KB) stay TRACKED — `.gitignore` ignores `journeys/evidence/**` and
negates that one folder — so a fresh clone still shows paint. New specs
`tests/unit/migrate-evidence.spec.ts` + evidence arms in `close-loop`,
`graph-simulate`, `serve-planner` and `planner-cards` (a real served server,
the image decoded in the browser). Docs: GRAPH-SPEC §2 + §4, README
merge-back bullet, DESIGN-PROJECTS §3.7, PARITY §4 + §7 (`/__evidence`).
Suite: **677 unit+harness green at 8 workers AND at 4.**
Not committed (human git).*

*4.4 done 2026-09-03 — **fewer concepts, same power** (review §3.1 / §4 #6,
#8, #9, #10). **Gap engine 12 → 8 kinds, 11 → 8 ops.** `computeGaps` now
returns `{ gaps, hints }`: a GAP has a write-back op behind it, a HINT does
not and never blocks. `session_no_url`, `no_oracles` and `no_deny_coverage`
became hints (which is what the 4.1 strip already called them); the two port
questions — "no port" and "keep the guess?" — were always one question and
merged into `data_port`. `api_no_timeout` now fires only for `db.`/`log.`
checks or when the graph spans more than one system, so a single-system
`api.*` check on the 10 s default is no longer a nag (the shipped
`lead_to_customer` opens with **zero** gaps, against eight before).
`no_session_policy` is asked once per system **per project**: `sfpw grillme`
collects the sibling graphs' settled systems and passes them in
(`settledSystems`); with no project context the question stays per graph, as
before. Ops: `confirmExpect`+`removeExpect` → `answerExpect {node,id,keep}`,
`confirmIo` folded into `setIo` (no `io` = confirm what is there),
`setOrigin` → `setExternal`, `setUrl` retired with its hint; the union is
`AnswerOp` and the list `ANSWER_OPS`. **Data-flow trim:** `bind` gone
(`consumes`/`updates` always receive `{ record: '{ref:<nodeId>.id}' }`),
`ref` gone (the node **id** is the handle — the "two data nodes may not share
a handle" rule collapses into id uniqueness), `origin` → `external?: boolean`
(`seed` was never used by a shipped graph; grep confirmed). The script form
prints/parses `(external)` instead of `as <handle>`; the planner's origin
select became one "exists already" checkbox. Old files still open: a new
`normalizeGraph()` runs in `resolve.loadGraphFile`, `cli/readGraph` and the
planner's `loadDoc`, mapping `origin:'seed'|'external'` → `external: true`,
dropping `origin:'step'`, `ref` and `data.bind`, each with a warning naming
the node or edge (`upgrade.ts` stays the v1 door and is untouched).
**Legacy self-wired personas removed:** `usernameEnv/passwordEnv/tokenEnv/
totpEnv` are gone from `PersonaDef` (a new `EffectivePersona` carries the
DERIVED names), with the `ownWiring` XOR, `effectivePersona`'s early return,
`envBlockFor`'s fallback, the `admin` SF_USERNAME/SF_PASSWORD/SF_ACCESS_TOKEN
fallback in `registry.ts` and the `.env.example` legacy block. Every
internal/portal persona must name an `account`; both refusals name the exact
fix (`add accounts["x"] … then set personas["x"].account`). All 13 personas
in the repo roster already did. **MMPM emitter** left `generate.ts`
(artifact #4) for `sfpw contracts <journey> [--out <dir>]`, off by default —
generating a journey no longer writes to a memory substrate as a side
effect. Docs: GRAPH-SPEC §4/§5/§7/§9/§13, README (8 kinds / 8 ops, the
`contracts` row, the normalize door), the graph-author skill's ask-order,
STUDY-DATA-FLOW §5 marked superseded, HANDOVER. Tests: `gaps.spec` rewritten
(10), new `contracts.spec` (4), `graph-dataflow`/`graph-infer`/`graph-script`/
`graph-spec`/`readme`/`personas`/`personas-wiring`/`serve-planner`/`doctor`/
`totp`/`planner-cards`/`planner-sheets` + the cast/runner harness fixtures
moved to accounts. Suite: **687 unit+harness green at 8 workers AND at 4**;
`sfpw grillme <ref> --json` prints only the new kinds. Not committed (human
git).*

*4.3 done 2026-09-03 — **one CLI; Playwright only where a browser is.**
`bin/sfpw.mjs` (+ `"bin": {"sfpw": …}`, executable) is a thin ESM launcher
that registers **tsx** — BOTH hooks: the ESM one so the .mjs can `import()` a
.ts entry, the CJS one because with no `"type": "module"` tsx transpiles
`src/**` to CommonJS and the extensionless `./schema` imports are resolved by
the require hook (registering one alone fails "Cannot find module
'./schema'"). Every command is a thin module in `src/cli/` — parse argv, call
the existing pure function, print — so the unit suite can import them
directly: `args.ts` (the shared parser: unknown option = exit 2, `--help`
anywhere, `--` passes through), `doctor grillme compose import pipeline sweep
suite record simulate fixture`, plus `playwright.ts` (the ONE place a browser
is started) and `graphFile.ts`. Grammar: `doctor [<ref>|all|project:<p>]` ·
`grillme <ref> [--apply <ops.json>] [--json]` · `compose <host> <sub>
[--after <s>] [--island]` · `import <file.xlsx|.csv> [--project <p>] |
--paste <file.txt>` · `pipeline <journey> [--aliases a=b,…] [--capability c]
[--graph] [--overwrite]` · `sweep [--delete] [--targets …] [--patterns …]` ·
`suite [<spec>] [playwright args…]` · `record <persona> <journey>
[--expect-denial]` · `simulate <ref> [--overwrite]` · `fixture:trace` ·
`fixture:artifacts`. Exit codes are the contract — **0** ok, **1** the honest
"no" (doctor not ready, no recordings, no org for sweep), **2** wrong usage —
errors on stderr, and `--json` puts the `Gap[]` array on stdout and nothing
else (it replaces the `GAPS_JSON …` line the skill used to scrape out of a
reporter's stdout; `.env` is read with `dotenv.parse`, not `config()`, whose
banner would land on stdout). `sweep` no longer needs Playwright at all: a
25-line fetch-backed request context feeds the same `SalesforceApi`. DELETED:
`tests/record/{doctor,grillme,ado-import,compose,pipeline,sweep}.spec.ts`;
the four that need a browser stay (`record`, `simulate` — `page.setContent`
renders the evidence cards —, the two fixture generators) and `sfpw`
delegates to them with the env set (`--dry-run` prints the exact command,
which is how the suite tests the wiring without a browser). The nine npm
scripts became `node bin/sfpw.mjs <command>` aliases, so `npm run doctor --
all` and `npx sfpw doctor all` are the same thing and muscle memory survives.
CI drops `--project=record` (it ran eight tests that skipped to green). The
planner's dev server now spawns `npm run record -- <persona> <journey>`
(argv, not env) and its copy-a-command surfaces say `npx sfpw suite …` /
`npx sfpw pipeline … --graph`. New `tests/unit/sfpw.spec.ts` (38 tests)
spawns the real bin: help, unknown command/option, doctor exit 1 + the "no
graphs" sentence, `--json` is exactly one line of JSON, `--apply` writes,
compose writes the host and never the sub, CSV and `--paste` imports, sweep
without an org, the four delegations verbatim, and the retirement itself.
`cli.spec`/`doctor.spec`/`gaps.spec` are untouched — they test pure
functions. Docs: README (a `sfpw` command table with the npm aliases beside
it, every env-var invocation rewritten), GRAPH-SPEC §2/§8/§9/§10/§12,
graph-author skill, CONTRIBUTING ground rule 6, DESIGN-PROJECTS §3.2/§3.7,
PARITY §3/§7/§10, HANDOVER, the project scaffolder + the salesforce project
README, the bug-report template. Suite: **677 unit+harness green at 8 workers
AND at 4** (38 of them the new spec); `--project=record --list` shows exactly
the four browser specs. Not committed (human git).*

| # | Deliverable |
|---|---|
| 4.1 | ✅ Remove `tools/planner-src.html` / `process-planner.html`; `npm run planner` serves the new one; README "Creating a graph" rewritten (Path A ≈ 18 actions); parity table rows all ✓; parity test now guards the new source. |
| 4.2 | ✅ Evidence to files (`mergeRun` writes `<graph root>/evidence/<id>/<runId>/<node>.jpg`, the graph stores the relative ref; `/__evidence` serves them; `tools/migrate-evidence.mjs` moves old inline paint out). |
| 4.3 | ✅ `sfpw` CLI (`doctor grillme compose import pipeline sweep suite`, `record`/`simulate`/`fixture:*` delegate to Playwright); argv not env vars, exit 0/1/2, `--help` everywhere; `tests/record/*` reduced to the four that need a browser; CI stops running the record project. |
| 4.4 | ✅ Gap engine 12 → 8 kinds, 11 → 8 ops (+ 3 hints with no op); data-flow trim (`bind`, `ref` → gone, `origin` → `external?`, `normalizeGraph()` load door); legacy self-wired personas removed; MMPM batch emitter behind `sfpw contracts`. |

**Sprint 4 is done.** Four deliverables, one theme: *fewer concepts, same
power*. 4.1 retired the v1 planner and rewrote the authoring path around a
script the canvas renders. 4.2 moved evidence out of the document and into
files. 4.3 replaced eleven Playwright specs-as-CLIs with one `sfpw` binary
that has exit codes and `--help`. 4.4 took the review's trim list: the gap
engine stopped asking questions whose answer is "the default", the data-flow
model lost its second handle namespace and its unused seed origin, and a
persona now always names the account that plays it. Nothing a graph could
express before it cannot express now; there is simply less to learn.

## Working rules

- Tests for everything: no deliverable lands without its spec; deletions delete their spec.
- The three gates at the end of every sprint; nothing merges red.
- `PLANNER-FEATURE-PARITY.md` is the checklist for Sprint 3 and the exit criterion for Sprint 4; `tests/unit/planner-parity.spec.ts` keeps it honest.
- Checkpoint to memory at the end of every sprint (task `v1.task.sf_planner_v2__build`).
