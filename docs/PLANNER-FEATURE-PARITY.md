# Planner feature parity — current planner → Journey Script Planner

*Every control, card field, gesture, shortcut, dev-server route and `window.planner` API
of `tools/planner-src.html` / `tools/serve-planner.mjs`, with where it lives in the
new design. `tests/unit/planner-parity.spec.ts` reads the planner source and fails
if a control exists in code but not in this table, or if a row has no valid
disposition — so a feature cannot be dropped silently during the conversion.*

**Dispositions:** `kept` (same behaviour, possibly a new home) · `automated` (the
tool now infers it; the manual control goes) · `merged` (folded into another
control) · `dropped` (removed on purpose — the reason is in the row) ·
`todo` (kept, not yet demonstrated in the prototype — must exist before the old
planner is retired).

The prototype column says whether the behaviour is demonstrated in
`docs/PROTOTYPE-journey-script-planner.html` today.

The **v2** column says whether it is SHIPPED in the real planner —
`tools/planner-v2/` built into `tools/journey-planner.html` (`npm run planner:v2`).
`✓` = working against the real ProcessGraph; `○` = still to come; `—` = dropped
with v1. A row may carry both when half of it landed. Sprint 4's retirement
gate is: no `○` left in this column — **met as of sprint 3.4** (2026-09-03):
the canvas landed in 3.2, the sheets and wizards in 3.3, and 3.4 closed the
last six rows (evidence sources, snapshot, `lastResult`, the api endpoint
form, the db/logger flags and the `handoff` hop).

## 1. Toolbar — file

| Control | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `f_library` open graph… | dropdown of built-in + browser-saved graphs, grouped by project | Library pane (left): projects → graphs with readiness dot and open-count; click opens | kept | ✓ | ✓ |
| `b_new` new | fresh graph with start + end, meta card opens | **New ▾ → Blank graph**: one empty session line, cursor in the role field | kept | ✓ | ✓ |
| `b_import` / `f_import` import (JSON file) | load a `.graph.json` from disk | **New ▾ → Open a file…** (same loader, `planner.load`) | todo | ○ | ✓ (New ▾ → Open a file…) |
| `b_cases` import cases | ADO `.xlsx`/`.csv` → project → pick cases → draft graphs (`ic_*` dialog) | **New ▾ → From an ADO export** — same three steps (project, file/previous import, pick), same server routes | kept | ✓ (dialog shell; server calls stubbed) | ✓ (New ▾ → From an ADO export) |
| `ic_project` `ic_newproject` `ic_previous` `ic_file` `ic_read` `ic_all` `ic_none` `ic_back` `ic_apply` `ic_more` `ic_done` `ic_close` | the import-cases wizard | same wizard, one sheet instead of a fixed dialog | kept | ✓ (shell) | ✓ (one sheet, three steps) |
| `f_insert` insert ▾ (compose as island) | bring a graph in disconnected, park to the right, human wires `login_as` and `end` | **Join another graph… / insert graph after…** on a session line: splice (sessions merge on system+role, records merge by name, `after` inferred). Island only when the composer refuses, and the refusal names the fix | kept | ✓ | ✓ (Join another graph… — splice, the refusal names the fix, island fallback) |
| `f_save` save ▾ → save to project | POST `/__graphs`, validate, atomic write, 409 → confirm overwrite, library refresh | **Save to project** (top bar); same route and overwrite confirm | kept | ✓ (simulated) | ✓ |
| `f_save` → save to (another) project… | prompt for project | project picker in the save sheet | todo | ○ | ✓ (the **Save to…** sheet) |
| `f_save` → save "…" in this browser / overwrite / save as… (browser) | localStorage saves for `file://` use | kept as the `file://` fallback only (served mode hides it) | kept | ○ | ✓ (file:// fallback) |
| `b_export` export → `export_out` bar | graph JSON printed into the footer input | **Export JSON** sheet (selectable, copyable) | kept | ✓ | ✓ |
| `b_download` download | download `<id>.graph.json` | Download button in the Export JSON sheet | todo | ○ | ✓ |

## 2. Toolbar — edit

| Control | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `b_add` add ▾ → `__personas` | paste role names / tick roster; new roles pick "logs in as" (`pp_paste` `pp_cast` `pp_roster` `pp_apply` `pp_env` `pp_close`) | roles are typed on the session line; an unknown role shows a *new login* pill; the card's *logs in as* picker offers a new login or an existing account; personas.json + `.env.example` are written on save through `/__personas/add` | merged | ✓ (line + pill; "logs in as" picker: ○) | ✓ (line + pill; the "logs in as" sheet runs on save) |
| `b_add` → `session` | typed node at viewport centre | **+ session** line (or drag-to-connect onto empty canvas) | kept | ✓ | ✓ |
| `b_add` → `data` | a record node | typing a record name on a step line creates the record; shared by name | automated | ✓ | ✓ |
| `b_add` → `checkpoint` | a named assertion state | a step line with checks and no record (`verify …` with no record = checkpoint) | merged | ○ | ✓ (`addTyped`) |
| `b_add` → `screen` | a page/modal state with `url` + `expects` | merged into checkpoint (one "state that carries checks" type, `docs/REVIEW-SIMPLIFICATION-2026-09-03.md` §3.1) | merged | ○ | — |
| `b_add` → `api` / `db` / `logger` | evidence-source nodes with `endpoint` / `queryable` / `searchable` | added from the check editor when a check needs one (`db.query` → pick or create a database; `log.traffic` → a log system; a handoff → an api hop); same node types, same validator rules | kept | ○ | ✓ (**evidence sources** on the step card: `ops.addInfraNode` writes the node AND its `touches` edge; the check's target becomes a picker) |
| `b_add` → `decision` / `action` (v1) | v1 node types | dropped — v1 authoring is retired (`process-graph/2` only; v1 graphs still load) | dropped | — | — |
| `b_connect` connect | click source, click target, then pick the relation from `ef_type` | drag-to-connect stays (edgehandles); the relation is inferred from the endpoint types (`start/session → session` = `login_as`, `session → record` = `does`), with a `does / must not` choice on drop | automated | ○ (script lines cover it; canvas drag-to-connect: ○) | ✓ (relation inferred + edgehandles drag, `does / must not` on drop) |
| `b_delete` delete / Delete key | remove selected node/edge; group delete via box selection | delete on the line tools and the card; Delete key on a canvas selection | kept | ✓ (lines) / ○ (Delete key) | ✓ |
| `b_graphmeta` graph → `gf_id` `gf_title` `gf_systems` `gf_actors` `b_meta_apply` `pm_close` | id, title, systems JSON, actors JSON | **⚙ graph** card: id, title, tags, systems as pills (+ system opens a form: label, kind, urlEnv, sessionPolicy); actors are derived from the session lines | kept (`gf_systems`/`gf_actors` JSON textareas → fields) | ✓ (id/title/tags) · ○ (system form) | ✓ (incl. the system form) |

## 3. Toolbar — view, test, project, mode

| Control | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `b_layout` layout | dagre auto-arrange | **auto layout** (canvas footer) resets `pos`; default layout is the lane grid | kept | ✓ | ✓ (resets `pos`, then the lane grid + dagre for strays) |
| `b_fit` fit | zoom to everything | automatic: the canvas fits its stage on every render/resize; pan/zoom of the cytoscape canvas stays in the real build | kept | ✓ (fit) / ○ (pan/zoom) | ✓ (cytoscape pan/zoom; `fit` on load and on the button) |
| `b_help` ? + `legend` | shapes legend + driving tips | hover titles on every pill/button; a `?` opens the same legend | todo | ○ | ✓ |
| `b_check` check ✓ + `issues` panel (`iss_close`) | MUST FIX / TO FINISH grouped by element, click-to-jump | the **check strip** (must fix · to finish · hints · captured) + **Fix next**; gaps appear inline on the line they belong to and in the node card | kept | ✓ | ✓ |
| `f_test` → `order` run order… (`runorder`, `ro_close`) | the sequence a run executes | the script *is* the run order (line numbers); canvas lanes are in chain order | automated | ✓ | ✓ (the line numbers) |
| `f_test` → `run` copy: run this graph | copy `SUITE=graph:<id> npm run suite` | **Run this graph** + suites (`SUITE=<name> npm run suite`); the `spec` entry went with `toSpec` when the generic runner landed (review §4 #3, sprint 1.2) | merged | ✓ (copy) | ✓ |
| `f_project` all projects / `__new` ＋ new project… | filter the library; scaffold a project | Library pane project header; **＋ new project** in the New ▾ and import sheets (`/__projects`) | kept | ○ (new project) | ✓ (library; New ▾ → ＋ New project…) |
| `f_mode` edit / view | read-only mode hides editing controls | **View** toggle (read-only, for sharing a repainted graph) | todo | ○ | ✓ |
| `b_undo` ↶ undo / ⌘Z | undo delete / insert / connect | undo stack over the document (every edit, not only structural ones) | todo | ○ | ✓ |

## 4. Node card (`p_node`)

| Field | Today (tier) | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `nf_label` label | free text; sessions default to `System · role` and never update | session label derived from system + role; records named on the step line; checkpoint label on its line | automated | ✓ | ✓ |
| `nf_url` app url / deep link | session landing URL, screen URL | **at** field on the session line + card | kept | ✓ | ✓ |
| `nf_actor` role / user | pick a role (adds it to actors) | **as** field on the session line; persona shown on the card | kept | ✓ | ✓ |
| `nf_account` account env (name only) | override the username env on a node | env names live on the login and are edited there (below); per-node override dropped — it duplicated the account's `usernameEnv` | merged | ✓ | ✓ |
| `nf_creds` credentials (.env) dots + rename + clear | presence dots from `/__envstatus`; rename a variable name (POST `/__personas`, rewrites the account); clear override | card **credentials — login X**: four rows (username, password, token, TOTP) with presence dots and editable names; a rename follows every role on the login; **Copy missing lines** | kept | ✓ (rename, dots) · ○ (clear override) | ✓ |
| `nf_capture` ▶ start capture + `nf_capture_cmd` | copies `RECORD_PERSONA=… RECORD_JOURNEY=… npm run record` | **● record** on the lane, on the line and on the card: starts the headed recorder through the dev server (`POST /__record`), lane shows *recording…* then *✓ recorded*; missing credentials → the lines to paste; terminal command under a disclosure | kept | ✓ (simulated round-trip) | ✓ |
| `nf_snapshot` / `nf_snapshot_img` snapshot | run evidence image; manual attach | run evidence painted on the step after a run (thumbnail on the card); manual attach stays on the card | todo | ○ | ✓ (thumbnail on the session and step cards; file input → data URL → `ops.setSnapshot`) |
| `xf_list` / `xf_add` checks: kind, `ms`, target, value, draft-confirm, remove, `lastResult` dot | four unlabelled inputs per check | check editor on the step card with labelled fields per kind; draft = amber pill, click to keep; `lastResult` paints the pill green/red after a run; budget (`timeoutMs`/`pollMs`) shown for backend kinds | kept | ✓ (editor, draft) · ○ (budget, lastResult) | ✓ (labelled fields, drafts, budget, and the `lastResult` dot on the pill AND the card row — title = the runner's message) |
| `nf_type` type | change a node's type in place | dropped — the type is the line kind (session / step / must not / checkpoint); change it by re-adding | dropped | — | — |
| `nf_system` system (extra) | required by the validator, hidden under *extra settings* | **on** picker on the session line, always visible | kept | ✓ | ✓ |
| `nf_catalog` step catalog name (v1 node) | v1 action nodes | dropped with v1 (catalog lives on the `does` edge → step line) | dropped | — | — |
| `nf_steps_status` `nf_journey` `nf_planned` steps status / journey id / planned ms | written by the pipeline and merge-back | read-only chips on the card (*recorded · journey x*, planned ms) — editing them by hand made the graph lie about a capture | merged | ✓ (recorded chip) · ○ (journey id, planned ms) | ✓ (status · journey · step indexes · planned ms · captured mean, all as chips) |
| `nf_method` `nf_path` endpoint (api node) | method + path | api node form when a handoff/api hop is added from a check | kept | ○ | ✓ (the api row of **evidence sources**, and the **replicated to** form) |
| `nf_queryable` / `nf_searchable` evidence access | db / logger flags | same checkboxes on the db/log node form | kept | ○ | ✓ (checkboxes on the db / logger row; `ops.setInfraField`, validated like every other edit) |
| `nf_notes` notes | free text | notes field on every card | todo | ○ | ✓ |
| `nf_recchip` ✓rec chip, `nf_typechip` | status chips | *✓ recorded* / *● record* pill on the line and lane | kept | ✓ | ✓ |

## 5. Edge card (`p_edge`)

| Field | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `ef_type` relation (10 types) | pick `login_as` / `does` / `denied` / `touches` / `requires` / `asserts` / `next` / v1 types | inferred from endpoints + line kind: session order → `login_as`; step → `does`; must-not → `denied`; check with no record → `asserts`; `touches` merges into `does` without catalog; `requires` becomes a Playwright dependency between graphs (review §3.1); `next` is the closing edge, written by the exporter | automated | ✓ | ✓ |
| `ef_label` label | free text | `<verb> <record>` on the step line | kept | ✓ | ✓ |
| `ef_catalog` step catalog | `<noun>.<verb>`, suggestion only as a placeholder | derived `<record>.<verb>`, shown on the line and card; override on the card | automated | ✓ (derived) · ○ (override field) | ✓ (derived + override) |
| `ef_auth` auth (login_as) | frontdoor / singleaccess / ui, must agree with the persona | **auth** picker on the session card, defaulting to the persona's | kept | ✓ (picker) | ✓ |
| `ef_capability` deny capability | required on `denied` | derived from the must-not line (`<record>.<verb>`), editable on the card | automated | ✓ | ✓ |
| `ef_io` data port | produces / consumes / updates; `ioDraft` | inferred by first-touch (first `does` onto a record = produces; later = consumes; edit-verbs = updates), amber `?` until confirmed; override on the card | automated | ✓ | ✓ |
| `handoff` edge (`data`/`api` → `api`/`data`, an integration hop; a `produces` port here = ambient definition) | drawn by hand, relation picked from `ef_type` | **replicated to →** on the record card: pick or create the api hop; the hop's `produces` port is set from the check that verifies it (`log.traffic` / `db.query`) | kept | ○ | ✓ (**replicated to →** on the step card; `ops.addHandoff` finds-or-creates the api hop with its method/path) |
| `ef_timing` timing | captured `meanMs` / `deltaMs` | painted on the step after a run | todo | ○ | ✓ (`meanMs` / `deltaMs` on the canvas step, `capturedMeanMs` on the lane) |

## 6. Canvas gestures

| Gesture | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| drag a node; positions saved as `pos` (`position` event) | cytoscape | same (cytoscape in the real build; SVG drag in the prototype); `pos` exported | kept | ✓ | ✓ (lane / record drag → `setLayoutPos`) |
| drag from a node edge to connect (`ehcomplete`) | edgehandles → edge of type `next`, then `ef_type` | edgehandles → relation inferred from endpoints (+ `does / must not` choice) | kept | ○ | ✓ (shift-drag; lane→lane re-chains, lane→empty adds a session) |
| SPACE-drag box select (`boxend`) + `groupbox` grip / edges (`gb_grip`, `gb_hit`) drag a group | rubber band + group frame | rubber band on empty canvas; drag any selected node moves the group | kept | ✓ | ✓ (SPACE-drag; the frame grip moves the group in one edit) |
| `dbltap` on empty canvas → quick node | adds an `action` node | `dbltap` on empty canvas → new session (first) or new record | kept | ○ | ✓ (new session at the click) |
| `dbltap` on a session → copy capture command | copies the record command | ● record on the lane starts it; the command is on the card | merged | ✓ | ✓ (● record on the line) |
| hover tips (`mouseover` / `mouseout`, `tipFor`) | every node/edge type explains itself | every pill/lane/button has a title; the legend stays under `?` | kept | ✓ (titles) | ✓ (titles + legend, and the canvas hover tip) |
| `tap` / `tapstart` select, `unselect` clears → card flies out, glued through `pan zoom drag` | n8n-style glued card | click a lane/step/line → card beside it; hides while dragging, re-anchors after | kept | ✓ | ✓ (script line, lane, step or record → the glued card) |
| edge labels with port glyph (`⇒ out` / `⇐ in` / `upd`) | label on the edge | port pill on the step (`⇒ produces` / `⇐ consumes` / `⇄ updates`) and on the canvas step box | kept | ✓ | ✓ (port pill on the step + the port-coloured canvas edge) |
| run paint: pass/fail border, timings, `lastResult` dots, `✓rec` chip | merge-back repaints the graph | same data, painted on lanes/steps/check pills after a run | todo | ○ | ✓ (pass/fail borders, `capturedMeanMs`, `meanMs`, ✓ recorded) |
| `Escape` exits connect mode | keyboard | Escape closes the card / sheet; connect mode no longer exists | merged | ✓ | ✓ |
| `Delete` / `Backspace` deletes selection | keyboard | same on a canvas selection | todo | ○ | ✓ |
| `⌘Z` undo | keyboard | same | todo | ○ | ✓ |
| status bar: valid/invalid · counts · readiness cockpit · chain/dataflow health · connect-mode hint | footer text | check strip at the top (counts as chips, ready state, Fix next); dataflow errors are must-fix rows | kept | ✓ | ✓ (the check strip) |

## 7. Dev server (`tools/serve-planner.mjs`)

| Route | Today | New design | Disposition | Prototype | v2 |
|---|---|---|---|---|---|
| `/__capabilities` | feature flags for the served planner | same | kept | — | ✓ |
| `/__envstatus` | booleans-only env presence | same — feeds the credential dots | kept | ✓ (mocked) | ✓ |
| `/__graphs` POST | validated atomic save, 409 on overwrite, then a rebuild + reload of every tab | same save; **no rebuild and no reload** — a saved graph is data, and the page re-reads `/__library` (review §5.3 d, shipped S2.3) | kept | ✓ (served) | ✓ |
| `/__imports` GET / POST, `/__imports/apply` | store an ADO file + manifest; apply picked cases | same | kept | ○ | ✓ |
| `/__personas` GET / POST | roster; rename a login's env variable names | same — the card's credential rows | kept | ✓ (mocked) | ✓ |
| `/__personas/add` | create personas/logins from pasted roles, write `.env.example` block | called on save for roles not in the roster | kept | ✓ (mocked) | ✓ (called on save: the "logs in as" sheet) |
| `/__projects` GET / POST | list / scaffold projects | same | kept | ○ | ✓ |
| `/__reload` (SSE) + watch/rebuild | live reload of the single-file planner; watched planner source AND data (`personas.json`, `journeys/graphs/`, `projects/`) | kept for development of the planner itself — watches planner source ONLY (`planner-src.html`, `build-planner.mjs`, `src/graph/`); saving a graph never reaches it | kept | — | ✓ |
| *(new)* `/__library` GET | — | the whole library read off disk per call — `{version, projects:[{name, graphs:[{ref, id, title, tags, sessions, captured, file, invalid?}]}], legacy:[…]}`, each graph validated by the shared schema; an invalid one is listed WITH its errors, never hidden | new | ✓ (served) | ✓ (+ a `suites` key) |
| *(new)* `/__recordings` GET | — | journeys under `recordings/<journey>/<persona>-<ts>/` with their captures (manifest first, directory name as the fallback) — the "From a recording" sheet names the journey and hands over `PIPELINE_JOURNEY=… PIPELINE_GRAPH=1 npm run pipeline`. The planner does NOT run the pipeline | new | ○ | ✓ |
| *(new)* `/__record` POST · `/__record/`\<id\> GET | — | spawn `npm run record` (`RECORD_PERSONA`/`RECORD_JOURNEY`) for a resolved journey → `{id, pid}`; poll the id for `status` + the last 40 output lines; one recording per journey (409) | new | ✓ (served) | ✓ |

## 8. `window.planner` test API

Every function the harness drives today keeps its name and contract in the new planner, so `tests/harness/planner*.spec.ts` stay meaningful:
`load` `export` `get` `addNode` `connect` `select` `selectMany` `selection` `deleteSelected` `validate` `save` `saveToProject` `testCommands` `readiness` `suggestCatalog` `newGraph` `addTyped` `tipFor` `issues` `applyPersonaWiring` `openFromLibrary` `library` `projects` `setProject` `graphProject` `insertGraph` `importCases` `personas` `runOrder` `undo` `undoDepth` `setMode` `layout` `nodes` `edges` `groupBox` `version` — disposition **kept**. Two additions: `script()` (the document as script text) and `record(sessionId)`.

## 9. Retirement gate

The old planner is removed only when every `todo` row above is `✓` in the new one **and** the harness suite (`tests/harness/planner*.spec.ts`, ~60 tests) passes against it unchanged except for label text. `tests/unit/planner-parity.spec.ts` enforces this table against the code on every run.

**Status after sprint 3.4 (2026-09-03): the gate is met.** No `○` remains in the
v2 column, and every old spec has a v2 equivalent driving
`tools/journey-planner.html` through `window.planner`:

- planner.spec.ts → **planner-v2-shell.spec.ts** + **planner-v2-cards.spec.ts** — the shell and the three node cards.
- planner-group.spec.ts → **planner-v2-canvas.spec.ts** — SPACE box-select, the frame grip, group delete, single-select cards.
- planner-import-cases.spec.ts → **planner-v2-sheets.spec.ts** — the ADO wizard, save-to-project, personas.
- planner-compose.spec.ts → **planner-v2-compose.spec.ts** — splice is the default; island is the fallback.
- planner-order-health.spec.ts → **planner-v2-order-health.spec.ts** — run order is the line numbers, not a dialog.
- planner-projects.spec.ts → **planner-v2-projects.spec.ts** — the library rail replaces `f_project`.

Where an old test asserted a v1-only control the v2 spec asserts the automated
equivalent instead and says so in a comment — the relation dropdown (`ef_type`)
against the inferred relation, `b_connect` against edgehandles, `#runorder`
against the numbered lines, `#f_project` against the library rail's project
groups. Sprint 4 deletes the old specs and the old planner; nothing else.
