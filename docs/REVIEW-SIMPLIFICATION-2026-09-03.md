# Review — feature accretion, simplification, and a new authoring UI

*2026-09-03. Code review of `src/graph`, `src/journeys`, `src/pipeline`, `src/personas`, `tools/` (planner + dev server), and a hands-on run of the planner (Path A from the README, driven with Playwright, screenshots land in `docs/review-shots/`, which is gitignored — regenerate them with `node tools/review/drive-planner.mjs` against a running `npm run planner`). Judged against the seven product goals: (1) UI-built journeys assembled across personas and systems, (2) inferred data elements shared between graphs, (3) speed and simplicity of creating/joining graphs, (4) hand- or AI-crafted graphs, (5) graphs → specs, (6) CI and local runs, (7) suites.*

## 1. Verdict in one paragraph

The domain model is right and the runtime half — `Cast`, the auth ladder, `runner.ts`, `mergeRun.ts`, `dataflowHealth()` — is the strongest code in the repo and should not be touched. The accretion is real but concentrated in three places: the **v1 graph model kept alive beside v2** (dead node/edge types, `upgrade.ts`, `fromDistillation.ts`, two walkers), a **CLI-shaped second answer to questions the UI already answers** (splice mode, `bind`, `ref`, `origin:'step'`, per-graph spec codegen, eleven Playwright specs acting as CLIs), and a **planner that exposes the schema instead of the workflow** (relation dropdowns, JSON textareas, connect mode, per-credential dots, six `<select>`s used as command menus). Roughly 1,500 LOC of `src/` and 30% of the planner script can go without losing a goal, and goal 7 (suites) is the only goal with essentially no code behind it. The UI fix is not cosmetic: the graph has a canonical linear shape (one login chain → sessions → steps onto records → checks), which is a *script*, and the planner should let people write the script and render the canvas — not the other way round.

## 2. What trying the planner showed (Path A, first-time user)

Counted from the driver run (`tools/review/drive-planner.mjs`), not from the README:

| Observation | Evidence |
|---|---|
| **≈ 70 user actions** for the README minimal graph (1 session, 1 record, 1 step, 2 checks, 1 denied, save). Every edge costs 6–11 actions because `connect()` always creates `type: 'next'` and the real relation is then picked from a 10-item dropdown. | `planner-src.html:982`; shots 14–18 |
| **Two adds stack on the same pixel.** `add ▾ → session` then `add ▾ → data` both land at the viewport centre; the session vanishes under the record. My first connect attempt wired `start → data` because the session was hidden. | `addNode()` 970–978; shot 13, positions `sess_1` = `data_1` = (200,260) |
| **`new` opens the meta card; the `graph` button toggles it closed.** No pressed state, so the first click on the obvious button hides the thing you were about to fill in. | 1628–1638; shots 4–5 |
| A fresh session is born with `check (5)` in red and the label `System · role` — which never updates after you pick a system and a role. | shot 10; export shows `label: "System · role"` with `system:'sf', actor:'client_associate'` |
| `system` is *required* by the validator but lives under *extra settings*; the front of the card leads with *snapshot* and a *Choose File* button on a node that has never run. | `NODE_TIERS` 705–722; shot 10 |
| A check is four unlabelled placeholder inputs (`ms`, `target / SObject / node id`, `expected value / text`) — I filled the SObject into the `ms` box, and the validator then blocked save. | shot 20 |
| The catalog placeholder is always `expense.submit`; `suggestCatalog()` computes the right one (`cust.create`) and throws it into a placeholder instead of the field. | 875–892; shot 17 |
| **Even the shipped reference graph opens with `check (8)`**, mostly `api_no_timeout` nags whose answer is "the default". | shot 2; `gaps.ts:123-130` |
| **`insert ▾ → expense_to_siebel` is refused**: "system `sf` is defined differently — align urlEnv/sessionPolicy". A new graph's default `sf` lacks `urlEnv`, so a first-time user cannot compose with any shipped graph. Goal 1 blocked by a default. | `insertGraph()` 1294–1330, `compose.ts` system-agreement; run log |
| `insert ▾` is empty until `mousedown` (menu is filled lazily); `save ▾` still offers "save *new_process* in this browser" after the id was applied. | 1914, `refreshSaveMenu` 1074–1096 |
| Cards overflow the viewport (session card runs off the bottom at 900px) and overlap each other and the check panel; edge labels overprint on every crossing. | shots 10, 22 |
| Save through the dev server triggers `tsc` **twice** + re-inlining 1.1 MB + a full tab reload of the app you are editing, recovered by a `sessionStorage` breadcrumb. | `build-planner.mjs:35-69,120-131`; `serve-planner.mjs:422` |

None of these are polish items. Together they mean the model leaks into every gesture: the user must know `login_as`, `does`, `denied`, ports, `<noun>.<verb>`, `after`, and env wiring before drawing a two-node graph.

## 3. The code: what is accretion and what is essential

### 3.1 Graph core (`src/graph`, `src/journeys`)

**Dead or duplicated (delete):**

- v1 model: node types `action`/`decision`/`snapshot` (`schema.ts:75`), edge types `navigates`/`deny` (`:123`), `PNode.catalog` (`:96`), the v1 branch of `toJourney.ts:46-143`, `upgrade.ts` (131 LOC), `fromDistillation.ts` (218 LOC, no caller outside its test). All four graphs on disk are v2. `deny` vs `denied` forces double-handling in `schema.ts:387`, `gaps.ts:135`, `toBatch.ts:63`, `mermaid.ts:35,85`.
- `toBatch.ts` (108) and `mermaid.ts` (103): no caller in `src/`, `tools/` or the planner. `toBatch` couples a test framework to the MMPM memory substrate.
- `runOrder()` in `compose.ts:140-179` is a second implementation of the v2 walk (kept because the planner can't import `toJourney.ts`), parity "pinned by a unit test". Make it *the* walk and have `toJourneyV2` consume it.
- `e_seq_*` reading-ladder edges (`fromAdo.ts:298-300`): canvas layout stored as graph content; n−1 extra edges through every validator, composer and export. Layout belongs to the planner.
- `requires` edges: parsed into `result.requires`, warned about, never read by `run.ts`. Either wire to Playwright `dependencies` (goal 7) or drop.
- `PEdge.data.stepIndexes` is written by `fromCapture.ts:185` and read at `:231,252` but is not declared in the schema (hence the `as PEdge` cast). Declare it.

**Over-general (trim):**

- Data flow: keep `io` (produces/consumes/updates) and `ioDraft` — they *are* goal 2. Drop `bind` (14 lines of validation, one line of use, no shipped graph, "no planner UI yet"), drop `ref` (a second handle namespace defaulting to the node id, one writer), collapse `origin` to an optional `external` flag. Minimal node = `{id, sobject?, external?}`, minimal port = `{io, ioDraft?}`.
- `compose.ts` splice mode (~120 LOC): CLI-only; the planner hard-codes island. But see §5 — the *UI* should offer "insert after «step»", which is splice with a picker, so the right move is to keep splice and delete island's "park it to the right and let the human rewire" path, not the reverse.
- `screen` vs `checkpoint`: both are "a state that carries `expects`"; one type with a flag.
- `touches` vs `does`: `touches` schedules nothing; a `does` with no catalog does the same job.
- Gap engine: 12 kinds → 8. `api_no_timeout` fires on every backend check without an explicit `timeoutMs` and is closed by restating the default (`GRAPH-SPEC.md:353`) — scope it to `db.`/`log.` or multi-system graphs. `no_session_policy` is a property of a system, answer it once per project. `session_no_url` and `no_oracles` are hints, not gaps (no op). `confirmIo` ⊂ `setIo`; `confirmExpect`/`removeExpect` are one op with a verdict.

**Essential (keep as is):** `schema.ts` validator, `dataflowHealth()`, `chainHealth()`, `expandVariants()`, `mergeRun.ts`, `runner.ts`, `resolve.ts`, `fromAdo.ts` (its parser is the seed of the new UI — §5), `fromCapture.ts` def-use inference.

### 3.2 Runtime packaging (`tests/record`, `toSpec`, pipeline, personas)

- **Eleven Playwright specs as CLIs** (`GRAPH_SPEC=`, `GRILLME=`, `COMPOSE=`, `ADO_FILE=`, `SIMULATE=`, `GRAPH_DOCTOR=`…): only `record`, `simulate` and `make-fixture-trace` need a browser. The rest inherit `test.skip()`-means-exit-0 (a typo'd env var "passes"), no `--help`, stdout interleaved with the reporter, `playwright-report/` rewritten by `npm run doctor`, and CI running 11 no-op tests. One `bin/sfpw.mjs` (+`tsx`) with `doctor | grillme | spec | compose | import | pipeline | sweep`, delegating `record`/`simulate` to Playwright, replaces ~285 LOC of harness and 8 npm scripts with a single argv grammar.
- **`toSpec.ts` is codegen for a constant.** The emitted spec differs per graph only in the graph path and the steps symbol; it hardcodes `tests/e2e/` while graphs live in gitignored `projects/*/graphs/` — a tracked spec pointing at an untracked graph breaks on a clean clone and in CI. One generic `tests/e2e/graphs.spec.ts` that iterates `selectGraphs(process.env.SUITE)` × `expandVariants()` deletes `toSpec.ts`, the committed per-graph specs and the `graph:spec` script — and is the suite runner goal 7 needs.
- **`baselines.json` is write-only**: `generate.ts:141` writes it, `loadBaselinesFile` has no production caller, `toSpec` never passes `baselines`, so the soft/hard timing grade in `runner.ts:286-314` is dead at runtime. Wire it (5 LOC) or delete it (280 LOC). Wire it.
- **Merge-back inlines base64 JPEGs into the graph** (`mergeRun.ts:101-112`): `lead_to_customer.graph.json` is 87 KB, 6 images; diffs are unreviewable. Write to `projects/<p>/evidence/<id>/<runId>/` and store a relative ref.
- **Personas three-layer model is justified** (role alias → persona → account → derived env names): ADO names roles, sandboxes have logins, many-to-one is real, `.auth/<account>.json` sharing falls out. Delete only the fourth, legacy path (`usernameEnv`… directly on a persona, `ownWiring` XOR, the `admin` fallback in `registry.ts:124-129`, `.env.example:8-13`). Nothing in `personas.json` uses it.
- **Business logic living only in the dev server**: `addPersonas()` + `.env.example` writing (`serve-planner.mjs:185-221`), `updatePersonaWiring()`, a bespoke `.env` parser duplicating `envDoctor()`, a fifth slug implementation (five across the repo with four truncation lengths — client and server independently slug the same role name). Move to `src/personas/` so CLI, skill and planner share one implementation.
- **CI**: runs typecheck, lint, unit+harness+record with no secrets — correct for the harness. There is no path for a real-org run: no secrets mapping (names are derivable → one `SF_ENV_JSON` secret or `sfpw env --github`), no `--project=e2e`, no artifact upload, and the repainted graph is written in place and discarded at job end. "Plan/test/report" exists locally only.

### 3.3 Planner (`tools/planner-src.html`, 2,411 lines)

- State is a mutable global `G` plus a second copy in cytoscape, reconciled by `syncPositions()` that must be remembered before every export/save/undo; `render()` destroys and rebuilds everything and `cy.fit()`s, so undo and insert reset the viewport.
- Eight string-built `innerHTML` renderers re-bound after each rebuild; every check keystroke re-renders the list; `setStatus()` runs validate + gaps + chain + dataflow synchronously per edit.
- Four client write paths for the JSON (export, localStorage, POST, download) and two server ones; browser-local saves and the dual library exist only for `file://`.
- Schema fields with no UI at all: `after`, `sobject`, `ref`, `origin`, `bind`, `alternatives`, `sessionPolicy`, `urlEnv` — reachable only through the raw JSON textareas. The README's "use `after` to tie a check to the step" cannot be done in the planner.
- Biggest functions: `renderIssues` (73), `renderCreds` (63), `renderExpectRows` (57), `tipFor` (48), `readNodeForm` (42), `icRead` (41), `applyPersonas` (40).

## 4. Ranked simplification plan (code)

| # | Change | Removes | Risk |
|---|---|---|---|
| 1 | Delete the v1 path (`fromDistillation`, `upgrade`, v1 walker branch, `action/decision/snapshot`, `navigates/deny`, node `catalog`; schema literal `'process-graph/2'`) + dead `toBatch`, `mermaid` | ≈ 1,050 src + 400 test LOC | very low |
| 2 | Decide baselines: **wire** `loadBaselinesFile` into `runGraphFile` deps | +5 LOC, a real feature stops being dead | low |
| 3 | One generic suite runner + `suites.json` (`{smoke:{graphs:[…]}, sod:{tags:[…]}, salesforce:{project:…}}`), tags on `ProcessGraph`, delete `toSpec.ts` + committed specs | −200 net; delivers goals 5, 6, 7 | low |
| 4 | Evidence to files, not base64 in the graph | 87 KB → 10 KB per run graph; reviewable diffs | medium (planner loads refs) |
| 5 | `sfpw` bin (+`tsx`) replacing 8 record specs and 8 npm scripts | ~flat LOC; correct exit codes, `--help`, clean CI | medium |
| 6 | Trim data flow: drop `bind`, `ref`; `origin` → `external?` | ≈ 70 LOC + one concept fewer per author | low |
| 7 | Unify walkers: `runOrder` is the walk, `toJourneyV2` consumes it | ≈ 35 LOC, one drift class gone | low-med |
| 8 | Gaps 12 → 8 kinds, 11 → 8 ops; ladder edges → planner layout; `screen`+`checkpoint` → one type; `touches` → `does`; declare `stepIndexes` | ≈ 120 LOC; /grillme stops asking "the default?" | low-med |
| 9 | Move `addPersonas`/env-wiring/slug out of `serve-planner.mjs` into `src/personas/`; MMPM batch emitter out of `generate.ts` into an opt-in command | ≈ 175 LOC moved, one slug | low |
| 10 | Drop legacy self-wired personas | ≈ 60 LOC | medium (release note) |
| 11 | Collapse the two journey species (capture replay into edge provenance) | ≈ 150 LOC | **high — last** |

Net: ≈ 1,800 LOC of `src/` and tests removed, ≈ 150 added for suites, no goal lost. Tests for each step: the affected unit specs are named in the per-area notes (`graph-v2`, `graph-tojourney`, `graph-from-distillation`, `graph-tobatch`, `graph-spec`, `close-loop`, `readme`, `ci-workflow`, `baselines`, `personas`, `gaps`); each deletion removes a spec, each addition (suites, `sfpw`, evidence refs) gets its own.

## 5. The UI: from schema editor to script editor

### 5.1 The insight

A valid graph has a canonical shape enforced by the validator and the walker: exactly one linear `login_as` chain; sessions ordered by that chain; steps (`does`) in declaration order inside a session; ports onto records; checks on records/checkpoints, optionally scoped `after` a step; `denied` edges as the security half. That shape is a numbered script:

```
create_customer            Salesforce
1  as Client Associate on /lightning/o/Account/list
   1.1 create  → Customer (Account)          ⇒ produces customer
       ✓ record exists (Account)  ✓ toast "was created"
   1.2 must NOT delete Customer               (cust.delete)
2  as Billing Collections
   2.1 verify Customer                        ⇒ consumes customer
```

Every graph field is derivable from that script: the chain from the session order, `login_as` from adjacency, `does`/`denied` from the line kind, catalog from `<record>.<verb>`, the port from first-touch (first `does` onto a record = `produces`; later = `consumes`; verbs edit/approve = `updates`; all `ioDraft` until confirmed), `after` from the step the check hangs under, `sobject` from the record, the persona from the role name (the personas dialog already slugs and creates). `fromAdo.ts` already parses exactly this grammar from ADO rows, and `gaps.ts` already turns every guess into a confirmable draft. The canvas remains — but as the *rendering and the report*, plus drag-to-reorder/drag-to-connect for people who think spatially. Nothing is lost for hand-crafters; everything is gained for AI: the script is a text artifact a model can write, complete or review with no schema knowledge (goal 4).

### 5.2 The proposed surface (prototype: `Journey Studio` artifact)

Three panes, one workflow, no modal dialogs:

- **Left — Library & Suites.** Projects → graphs, with a readiness chip per graph (`3/3 bound · 2 captured · 0 drafts`) and a *records* facet: which graphs produce/consume `Customer`, `Lead`, `Expense`. Suites are saved selections (`smoke`, `sod`, `salesforce`) with tag filters; *Run* runs a suite locally or copies the CI line. This is goals 2, 6, 7 in one pane: the record ledger is *the* inferred data element view.
- **Centre — Script + Canvas** (tab or split). The script is an outline editor: a session row (`as <role> on <system> · <landing url>`) and step rows (`<verb> <record>` with a port pill and a check list). Typing `create Customer` on a fresh record makes a `produces` pill; a second graph consuming `Customer` shows the pill as *consumes ← create_customer*. Drafts are amber pills; clicking confirms. The canvas renders the same document with the login chain as a vertical spine, sessions as swim-lanes, records as shared nodes between lanes, and paints pass/fail after a run.
- **Right — Inspector.** Context for the selected line only: role → persona → login (with the doctor's exact `.env` lines, not per-field dots), the record's SObject and who else produces/consumes it across the project, the check editor with labelled fields, the capture command. *Extra settings* disappears — a line has ≤ 6 fields.
- **Top — one Check strip.** `must fix n · to finish n · ready to capture n` with a *Fix next* button that focuses the next line, replacing the floating panel and the `check (8)` badge. Gaps are shown inline on the line they belong to.
- **Join** is a single action on a session or step row: *insert graph after this step* → picker → the graph splices in (sessions merge on system+role, records merge by name, `after` inferred by `inferSplicePoint`); the island path stays only as the fallback when the composer refuses, and the refusal names the fix (e.g. "add `urlEnv` to `sf`") with a one-click apply.
- **Import & AI** are entries in the same *New* menu: *blank*, *from ADO export*, *from a recording*, *paste a script* — the last is the AI door: paste text in the grammar above (or ask the model to write it from a test case) and the same parser drafts the graph.

Removed: connect mode, relation dropdown, `add ▾` palette (records/checkpoints/systems come from the script; db/logger/api nodes are added from the inspector of the check that needs them), the meta card's JSON textareas, browser-local saves, the legend, `▶ test ▾` (replaced by Run), the personas dialog (roles are typed on the session row and created on save), the credential dots.

Action count for the same minimal graph: **≈ 18** (new → name → type one session line → two step lines → two checks → save), against ≈ 70 today.

### 5.4 What the redesign keeps (owner questions, 2026-09-03)

Nothing the current planner can do is dropped; several things move or become automatic.

| Today | In the redesign |
|---|---|
| Drag nodes on the canvas; positions saved as `pos` | Kept. Same cytoscape canvas in the real build (the prototype's SVG drags too); `pos` stays in the schema and the export. *Auto layout* resets it, as `layout` does today. |
| SPACE-drag rubber band, group box, drag a group | Kept. In the prototype: drag on empty canvas = band; drag any selected node = the group moves. |
| Drag from a node edge to connect (edgehandles) | Kept — and the relation is inferred from the endpoint types (`start/session → session` = `login_as`, `session → record` = `does`, with a two-button `does / must not` choice). The **connect** button and the 10-item relation dropdown go. |
| `insert ▾` (compose as island) | Kept as **Join another graph… / insert graph after this step**: splice by default (same role+system sessions merge, records merge by name), island only when the composer refuses — and the refusal names the one-click fix. |
| Personas dialog, `add ▾ → personas…` | Roles are typed on the session line; new personas/logins are created on save (same `addPersonas` code, moved into `src/personas/`). |
| Check panel + `check (n)` badge | The check strip (`must fix · to finish · captured`) plus inline pills on the line each gap belongs to; *Fix next* jumps. |
| `▶ test ▾` copy make-spec / run-spec | *Run this graph* / suites with one `SUITE=<name>` line (needs the generic runner, §4 #3). |
| Left/right panes | Collapsible (`⌘[` / `⌘]`), so the canvas can take the whole width. |
| Undo (`⌘Z`), view mode, download, export JSON | Kept (undo and view mode are not in the prototype). |
| Raw JSON textareas for systems/actors | Replaced by the inspector's fields; JSON stays reachable via *Export JSON*. |

### 5.3 What has to change in code for the UI

Almost nothing new in the model — that is the point. Needed: (a) a `script ⇄ graph` codec in `src/graph/script.ts` (parser is `fromAdo`'s step grammar generalised; printer is ~80 LOC), tested round-trip on the four shipped graphs; (b) `inferPorts(graph)` extracting the first-touch rule from `fromCapture.portFor` + `fromAdo.verbIo` so hand-drawn edges get drafts too; (c) `suites.json` + `selectGraphs()` + the generic runner (§4 #3); (d) a `GET /__library` route so save is a fetch, not a rebuild + reload; (e) the planner rewritten around one document store with a declarative field table (the string-built cards go). The cytoscape canvas, `dataflowHealth`, `chainHealth`, `computeGaps`, `composeGraphs` are reused as they are.

## 6. Suggested order

1. §4 #1–#3 (delete v1, wire baselines, suites + generic runner) — mechanical, one PR each, tests move with them.
2. `script.ts` codec + `inferPorts` with round-trip tests on the shipped graphs — this is the foundation the UI needs and it is useful to the AI skill immediately (`skills/graph-author` can emit the script instead of JSON).
3. The new planner shell (library, script editor, inspector, check strip) over the existing canvas, one harness spec per pane.
4. `sfpw`, evidence-to-files, gap trimming, personas cleanup.
