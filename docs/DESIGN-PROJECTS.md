# DESIGN — Projects: multi-team, multi-application structure

*Proposal, 2026-09-01. Status: for review — no code changed yet.*

## 1. The problem

The framework today assumes ONE team testing ONE blended scope. The real
organisation is several teams, several applications, two kinds of testing:

| Team | Application(s) | Testing scope |
|---|---|---|
| Web | digital front-end | one web app, app-scoped |
| Salesforce | SF org | from Salesforce down |
| Siebel | Siebel | from Siebel down |
| O2 | O2 provisioning | provisioning flows |
| OM / EOC | order mgmt / EOC | app-scoped |
| (cross-team) | all of the above | E2E journeys spanning applications |

Teams need to work in parallel without tripping over each other's graphs,
captures, screenshots, baselines and generated code — while E2E journeys
(like `lead_to_customer`, which already spans SF → Siebel) need to REUSE what
the application teams build, not duplicate it.

**The primary goal is reuse: any application project can use the assets of
any other — captured step vocabularies, whole recorded flows, system
definitions, personas, component objects, data factories — so the same login,
the same "create a lead", the same Siebel screen object is built once, by
the team that owns it, and consumed everywhere.** Isolation (ownership,
folders, CI lanes) is in service of that: clear owners are what make assets
trustworthy enough to reuse.

## 2. How it works today (verified against the code)

Everything lives in one flat namespace at the repo root:

```
journeys/graphs/<id>.graph.json      all graphs, one folder
journeys/<id>.generated.json         pipeline-generated journeys
journeys/baselines/<id>.baselines.json
journeys/telemetry.jsonl             labour telemetry, one stream
src/journeys/generated/<id>.steps.ts generated step vocabulary, one folder
tests/e2e/<id>.journey.spec.ts       emitted specs, one folder
recordings/<journey>/<persona>-<ts>/ capture scratch (gitignored)
.auth/<persona>.json                 cached sessions, per persona
personas.json                        ONE roster: org + sites + all personas
.env                                 ONE secrets file (names in personas.json)
```

The flatness is load-bearing in ~12 places: the CLIs resolve
`journeys/graphs/<id>.graph.json` directly (grillme, doctor, graph:spec,
simulate, ado:import, pipeline), `build-planner.mjs` embeds that folder as
the planner's built-in library, `toSpec` hardcodes the path into emitted
specs, and `fromAdo`/`fromCapture` write there.

Three existing seams already point at the future:

1. **`PLANNER_ROOT`** — the dev server's data dir is overridable; the planner
   can already serve a different folder's graphs/personas/.env status.
2. **`generate.ts outDirs`** — pipeline output dirs (journeys, stubs,
   baselines) are already parameters with flat defaults.
3. **The graph's `systems` block** — every graph declares its systems
   (`sf`, `siebel`) with `urlEnv` + session policy. Nothing shares these
   between graphs yet, but the shape is exactly a registry entry.

Also relevant: `uniqueName(base, prefix='E2E')` takes a prefix, the sweeper
selects by that prefix, and (since today) the API oracle fences its SOQL to
it. One knob already threads naming → cleanup → assertion scoping.

## 3. Proposal — `projects/` as the ownership unit

**A project is a folder that owns everything a team produces; the platform
(`src/`, `tools/`, the gates) stays shared.** One repo, many projects:

```
salesforce_playwright/
├── src/                        PLATFORM — shared, unchanged responsibilities
├── tools/                      planner + CLIs — shared
├── personas.json               shared org roster (see §4.3 for extensions)
├── .env                        ONE secrets file, root only (unchanged rule)
├── .auth/                      cached sessions (persona-keyed, shared)
├── shared/
│   └── systems.json            system registry: sf, siebel, o2, om, eoc …
└── projects/
    ├── digital-frontend/       ← web team
    │   ├── project.json        manifest (id, team, systems, namePrefix…)
    │   ├── graphs/*.graph.json
    │   ├── journeys/           generated journeys + baselines/
    │   ├── steps/              step vocabulary (generated + hand-written)
    │   ├── specs/              emitted *.journey.spec.ts
    │   ├── recordings/         capture scratch (gitignored)
    │   ├── evidence/           run reports + screenshots (gitignored)
    │   └── docs/
    ├── salesforce/             ← SF team, same shape
    ├── siebel/                 ← Siebel team
    ├── o2-provisioning/        ← O2 team
    ├── om-eoc/                 ← OM/EOC team
    └── e2e-journeys/           ← cross-application journeys
        ├── project.json        declares uses: [salesforce, siebel, …]
        └── graphs/lead_to_customer.graph.json
```

Ownership becomes filesystem-shaped: `CODEOWNERS` maps `projects/siebel/` to
the Siebel team; a team's PR touches its own folder; platform changes go
through the usual three gates plus review.

**Projects are created, not configured.** Nothing in the platform enumerates
project names — the names above are illustrations, not a registry. A team
creates its own project and the tooling discovers it by scanning
`projects/*/project.json`:

```
npm run project:new -- o2_provisioning --team "O2"     # CLI
planner toolbar → project ▾ → ＋ new project…           # UI (served mode)
```

Both routes run the same scaffolder (`tools/scaffold-project.mjs`): validate
the name, refuse an existing one, create the folder shape (graphs / journeys
/ steps / specs / recordings / evidence / docs), write `project.json` with a
derived `namePrefix`, and the planner's graph library regroups on the next
rebuild. Deleting a project is deleting its folder.

### 3.1 The manifest — `project.json`

```json
{
  "project": "salesforce",
  "team": "SF QA",
  "description": "Salesforce-down testing for the UAT org",
  "systems": ["sf"],
  "uses": [],
  "namePrefix": "E2E_SF"
}
```

- `systems` — keys into `shared/systems.json`; the doctor can report
  readiness per project (which env vars this team actually needs).
- `uses` — other projects whose step vocabularies and systems this project
  composes (the E2E mechanism, §5).
- `namePrefix` — threads the existing knob: `uniqueName` prefix → sweeper
  target → API-oracle scope. Each team's records are born fenced; sweeping
  `projects/siebel` data can never touch web-team data.

### 3.2 Graph references

Every CLI keeps its env-var interface; the value gains a project segment:

```
GRILLME=salesforce/lead_intake        npm run grillme
SUITE=graph:e2e-journeys/lead_to_customer npm run suite
SIMULATE=digital-frontend/checkout    npm run simulate
GRAPH_DOCTOR=project:siebel           npm run doctor     (whole project)
```

One new helper (`src/graph/resolve.ts`) resolves `<project>/<id>` →
`projects/<project>/graphs/<id>.graph.json`. A bare `<id>` searches all
projects: unique match proceeds (with a note), ambiguity errors listing the
candidates, and `journeys/graphs/` remains a read-only legacy alias during
migration so nothing breaks on day one.

### 3.3 Personas and secrets — mostly unchanged

`personas.json` stays ONE file: personas are an organisational reality
(the same `siebel_admin` serves every project), the `.auth/` session cache
is persona-keyed, and splitting rosters would fork the auth ladder for no
gain. Two small additions:

- a project MAY add actors in `projects/<p>/personas.project.json` (same
  schema, merged over the root roster at load; name collisions refuse).
- `.env` stays a single root file — the secrets discipline (names in JSON,
  values only in .env, planner edits names not values) is working; spreading
  secrets across folders would weaken it.

Multi-org reality (web team's sandbox ≠ SF team's UAT) is deliberately
deferred to env profiles (§7) — one decision, not smuggled in here.

### 3.4 The reuse model — what a project exports, what `uses:` imports

Every asset kind gets one owner and one import path:

| Asset | Lives at (owner) | Reused by others via |
|---|---|---|
| Step vocabulary (`lead.create`) | `projects/<p>/steps/` | `uses:` — auto-registered into the consumer's catalog |
| Deny probes | `projects/<p>/steps/` | same registry, same `uses:` |
| Whole recorded flows | `projects/<p>/journeys/*.generated.json` | slice replay (below) |
| System definitions | `shared/systems.json` | referenced by key from any graph |
| Personas + cached sessions | root `personas.json` / `.auth/` | already global |
| Component objects (app-specific screens) | `projects/<p>/lib/` | plain TS import via `@projects/<p>` path alias |
| Data factories ("a qualified lead") | `projects/<p>/lib/` | same alias |
| Graphs | `projects/<p>/graphs/` | referenced read-only (`<project>/<id>`) — e.g. an E2E doctor walks them; never copied |

Generated steps move beside their graphs (`projects/<p>/steps/<id>.steps.ts`
— the pipeline's `outDirs` seam already supports this). Each project exports
one `registerSteps(catalog)` from `steps/index.ts`. An emitted spec registers
its own project's vocabulary plus every project in `uses:` — the existing
`StepCatalog` collision rule (register twice = throw) becomes the merge
policy: a clash across projects is a NAMING conversation (`lead.create` vs
`sf.lead.create`), surfaced loudly at load, never silently resolved.

**Flow-level reuse is already built**: `src/journeys/slice.ts`
(`runJourneySlice`) replays the recorded micro-steps behind a named edge
from a generated journey file. That is the deepest anti-duplication tool in
the box — the web team's captured "checkout" or the SF team's captured
"create lead" becomes ONE composite step any other project's journey calls,
with placeholders resolved by the same resolver the runner uses. Nobody
re-records a flow another team owns; when the owning team re-captures,
every consumer replays the new recording on their next run. The only change
projects add is path awareness: the composite step resolves its journey file
through the owning project's folder instead of the flat `journeys/`.

App-specific component objects (a Siebel screen, an O2 provisioning form)
move from the shared `src/` into the OWNING project's `lib/`, exported
through `lib/index.ts` and imported anywhere as `@projects/siebel` (a
tsconfig path alias — one mapping, typechecked, jump-to-definition works).
`src/` keeps only the platform-generic layers (Cast, runner, Lightning
component objects, graph engine). The rule of thumb: if only one
application's tests could ever need it, it belongs to that application's
project; everything else is platform.

### 3.5 Planner

Phase 1 is free: `PLANNER_ROOT=projects/salesforce npm run planner` already
serves that folder's graphs + personas wiring. Phase 2 adds a `/__projects`
endpoint and a project dropdown next to `open graph…`, and `build-planner`
groups the built-in library by project instead of one flat list.

### 3.6 Playwright and CI

The four runtime projects (unit / harness / record / e2e) are about HOW a
test runs and stay as they are. Team scoping is path scoping:

- `e2e` project's `testMatch` widens to `projects/**/specs/**/*.spec.ts`;
- a team lane is `npx playwright test projects/siebel/`;
- CI grows a matrix job derived from `projects/*/project.json` — each team
  sees its own red, plus the shared unit+harness gate for the platform.

### 3.7 Evidence

Run output (report.json, per-step screenshots) lands in
`projects/<p>/evidence/<graph_id>/<runId>/` via the runner's existing
`runDir` parameter — gitignored; the graph keeps embedding its ≤300KB
thumbnails so the planner still paints, and heavyweight evidence has a
predictable, per-team home (retention policy per team, not per repo).
Telemetry events gain a `project` field; `npm run labour` reports per team.

## 4. Cross-application E2E — the point of the exercise

`lead_to_customer` moves to `projects/e2e-journeys/` and declares
`uses: [salesforce, siebel]`. What that buys:

- **Systems** come from `shared/systems.json` — the SF url env, the Siebel
  max-1 session policy live ONCE; the graph validator warns when an inline
  system def diverges from the registry (inline still allowed — graphs stay
  self-contained documents).
- **Vocabulary** composes — the E2E spec runs on the SF team's captured
  `lead.create` and the Siebel team's `siebel.check_customer`; the E2E team
  captures nothing the app teams already own.
- **Readiness aggregates** — `GRAPH_DOCTOR=project:e2e-journeys` walks
  `uses` and reports every env var the whole journey needs.
- **Naming**: E2E runs use their own `namePrefix` (`E2E_X`), so a
  cross-app run's records are distinguishable from any app team's — and the
  API oracle's run-scope fencing (built today) already keeps parallel teams
  from greening each other's checks.

App-scoped testing and E2E testing are then the same machinery at different
folder depths — which is the property that keeps the platform singular.

### Graph composition — extend a workflow by importing another graph

**SHIPPED 2026-09-01** (`src/graph/compose.ts`): join `add_address` into
`create_customer` and the test covers more functionality.

```
COMPOSE=<host_ref> COMPOSE_WITH=<sub_ref> [COMPOSE_AFTER=<session_id>] npm run graph:compose
planner: insert ▾ (file group) — splices after the selected session
```

It is a COPY-MERGE with provenance, not a live reference: the sub's nodes and
edges are copied in, and `composedFrom` records `{ref, graphId, at}` so
staleness is detectable later. Two modes (owner decision 2026-09-01: **"I add
the connection in the graph editor"**):

- **island (default, and the only planner behavior)** — the sub arrives
  intact but DISCONNECTED: no session merging, the chain untouched, edges to
  the sub's end dropped (relink after wiring). Its internal login chain is
  kept, so wiring in is one `login_as` edge from a previous step plus the
  end relink — and chain health lists the stranded sessions red/amber until
  it's done. The human is the wiring authority; the tool referees.
- **splice (CLI opt-in via `COMPOSE_AFTER`)** — auto-wire for scripted use:
  sessions merge when system+actor+account agree (sub steps append after the
  host's), the sub-chain splices in after the named session with auth
  carried and a return edge, and sub-end edges re-aim at the host's end.

Both modes: other nodes merge on same id+type (data nodes union their
checks, exact duplicates collapse) and import under a `<sub_id>_` prefix on
true collisions; imported checks follow their renamed `after` edges; the
sub's start is always dropped. Actor-alias and system disagreements ERROR —
never a silent rebind. The composed result must validate AND keep a walkable
chain or the compose throws; the walker/runner/planner/merge-back need no
changes because the output is an ordinary graph.

Chosen over live subgraph-reference nodes on purpose: references would touch
walker, validator, planner, and merge-back (which paints ONE file), and the
document doctrine — a graph is self-contained — is what keeps every existing
tool working. Live propagation of upstream changes is exactly what slice
replay gives at the STEP level; a future `graph:recompose` can diff
`composedFrom` stamps against the source graphs when staleness bites.

## 5. What stays shared, deliberately

`src/` (Cast, runner, oracles, graph engine, pipeline), `tools/`, the three
gates (typecheck / lint / suite), `.env`, `.auth/`, the persona roster, the
`E2E_` outer naming convention, and the planner. A team never copies
platform code into its project; a project folder contains only *data and
generated artifacts* (graphs, steps, specs, evidence) plus docs.

## 6. Migration — incremental, nothing breaks

- **M0 — resolver + folders** (~½ session): create `projects/`, move the
  three graphs (`lead_to_customer` + `_via_ado` → `e2e-journeys/`,
  `expense_to_siebel` → `siebel/`), add `resolveGraphRef` with the legacy
  fallback, update the ~12 hardcoded `journeys/graphs` sites + their tests.
- **M1 — manifests + doctor/planner awareness**: `project.json`,
  `GRAPH_DOCTOR=project:<p>`, planner PLANNER_ROOT recipe documented,
  `/__projects` + dropdown.
- **M2 — output relocation**: pipeline `outDirs` → project folders
  (journeys, steps, baselines, recordings); one generic suite runner
  (`tests/e2e/graphs.spec.ts`) covers every project graph (`SUITE=project:<p>`).
- **M3 — team fencing**: `namePrefix` wired through uniqueName / sweeper /
  oracle scope; telemetry `project` field; CI matrix; CODEOWNERS.
- **M4 — deferred decisions** (§7).

Each step lands with the usual tests; the legacy alias is deleted only when
M2 completes.

## 7. Open decisions for the team (not designed here)

1. **Env profiles / multi-org** — one `.env` per checkout today. If two
   teams genuinely point at different orgs from one checkout, we add
   `ENV_PROFILE=uat|sit` selecting `.env.uat` etc. Decide when it hurts.
2. **Monorepo vs repo-per-team** — this design says monorepo: the platform
   moves fast, E2E composition needs sibling projects at build time, and
   version-skewing five copies of `src/` is the known failure mode. Revisit
   only if org policy forces a split (then: platform becomes an npm package,
   projects become consumers — strictly more machinery).
3. **Evidence retention** — per-team policy for `evidence/` (age-out script
   vs artifact storage); nothing in-repo blocks either.
4. **O2 / OM / EOC system kinds** — `shared/systems.json` will need honest
   `kind` entries (probably `web` or `other` + session policies); captured
   when those teams onboard, not invented now.

## 8. Summary

One platform, many project folders — built so any application can use any
other's assets. A project = manifest + graphs + steps + lib + specs +
evidence, owned by a team; its steps and deny probes flow to consumers via
`uses:`, its recorded flows via slice replay, its screen objects via one
path alias, its systems via the shared registry — so nothing is captured,
coded, or declared twice. Every existing CLI keeps its interface with a
`<project>/` segment in the value; four seams the code already has
(`PLANNER_ROOT`, `outDirs`, the systems block, `runJourneySlice`) do most
of the work; migration is four small, individually-shippable steps with a
legacy alias until the last one.
