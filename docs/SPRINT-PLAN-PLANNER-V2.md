# Sprint plan — Journey Script Planner (planner v2) and the simplification

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

| # | Deliverable |
|---|---|
| 4.1 | Remove `tools/planner-src.html` / `process-planner.html`; `npm run planner` serves the new one; README "Creating a graph" rewritten (Path A ≈ 18 actions); parity table rows all ✓; parity test now guards the new source. |
| 4.2 | Evidence to files (`mergeRun` writes `projects/<p>/evidence/<id>/<runId>/*.jpg`, graph stores refs). |
| 4.3 | `sfpw` CLI (`doctor grillme compose import pipeline sweep suite`; `record`/`simulate` delegate to Playwright); `tests/record/*` reduced to the browser-needing three. |
| 4.4 | Gap engine 12 → 8 kinds; data-flow trim (`bind`, `ref` → gone, `origin` → `external?`); legacy self-wired personas removed; MMPM batch emitter behind `sfpw contracts`. |

## Working rules

- Tests for everything: no deliverable lands without its spec; deletions delete their spec.
- The three gates at the end of every sprint; nothing merges red.
- `PLANNER-FEATURE-PARITY.md` is the checklist for Sprint 3 and the exit criterion for Sprint 4; `tests/unit/planner-parity.spec.ts` keeps it honest.
- Checkpoint to memory at the end of every sprint (task `v1.task.sf_planner_v2__build`).
