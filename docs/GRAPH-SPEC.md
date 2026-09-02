# Process-graph specification (`process-graph/2`)

*Normative. This is the one document an author — human or AI — needs to
create, complete, or review a graph. It is derived from the validator
(`src/graph/schema.ts`), the referees (`src/graph/compose.ts`), the walker
(`src/graph/toJourney.ts`) and the gap engine (`src/graph/gaps.ts`); a
drift test (`tests/unit/graph-spec.spec.ts`) fails the build if the code
gains a type, kind, gap or op this page does not mention. Design history
lives in `DESIGN-PROCESS-GRAPH.md`, `STUDY-TEST-GRAPH-REPRESENTATION.md`,
`DESIGN-EXPECTATIONS.md`, `STUDY-DATA-FLOW.md`.*

## 1. What a graph is

A graph is **the plan, the test source and the report** for one business
process. It is a typed property graph:

- **Nodes are states** — where/who you are (`session`), what exists
  (`data`), what must be true (`checkpoint`), plus evidence sources (`db`,
  `logger`, `api`).
- **Edges are relations** — what you do (`does`), how you got there
  (`login_as`), what must be refused (`denied`), what is checked
  (`asserts`), what depends on what (`requires`, `touches`, `handoff`).
- **Assertions live on nodes** (`expects`), never on edges (model-based
  testing doctrine: verify in the vertex, act on the edge).
- **Data flows on the edges** — an edge onto a `data` node carries a port
  (`produces` / `consumes` / `updates`), which is how a record's id reaches
  later steps.

A run walks the graph into a journey, executes it as the personas the
graph names, evaluates every expectation, and **repaints the same graph**
(pass/fail, timings, screenshots). There is no second artifact.

## 2. Files, ids, references

| Thing | Where | Rule |
|---|---|---|
| Graph | `projects/<project>/graphs/<id>.graph.json` (legacy: `journeys/graphs/<id>.graph.json`) | `id` = lower_snake_case, equals the file stem; the planner's *save ▾ → save to project* writes it (validated, atomic) |
| Reference | `<project>/<id>`; bare `<id>` resolves in the legacy folder | used by every CLI (`GRAPH_SPEC`, `GRILLME`, `COMPOSE`…) |
| Project | `projects/<project>/project.json` (+ `graphs/ imports/ journeys/ steps/ specs/ recordings/ evidence/ docs/`) | `npm run project:new`, or from the planner |
| Personas | `personas.json` (root) | the roster graphs bind roles to — **never invent a persona id** |
| Imports | `projects/<project>/imports/<stamp>-<name>.<xlsx|csv>` + `.json` manifest | the ADO file, verbatim, and which case became which graph |

All ids (graph, node, edge, expectation, actor alias, system key) match
`^[a-z][a-z0-9_]*$`. Env-var **names** match `^[A-Z][A-Z0-9_]*$`; a value
that looks like a URL with credentials, or an inline secret, is rejected.

## 3. Document shape

```jsonc
{
  "schema": "process-graph/2",
  "id": "lead_to_customer",
  "title": "Lead → customer, replicated to Siebel",   // optional
  "systems": { "<key>": SystemDef, ... },
  "actors":  { "<alias>": "<personaId>", ... },       // alias → personas.json id
  "nodes":   [ PNode, ... ],
  "edges":   [ PEdge, ... ],
  "composedFrom": [ { "ref", "graphId", "at" } ]      // optional provenance (compose)
}
```

`process-graph/1` (action nodes + `next` edges) still loads and is
auto-upgraded; **write v2 only.**

### 3.1 Systems

```jsonc
"sf":     { "label": "Salesforce", "kind": "salesforce", "urlEnv": "SF_INSTANCE_URL" },
"siebel": { "label": "Siebel", "kind": "siebel", "urlEnv": "SIEBEL_URL", "sessionPolicy": { "maxConcurrent": 1 } }
```

`kind` ∈ `salesforce` · `siebel` · `web` · `api` · `other`. `sessionPolicy.maxConcurrent`
(integer ≥ 1) is enforced at run time: the Cast logs personas out (LRU) to
stay within it. Siebel classically needs `1`. Non-Salesforce systems without
a policy raise the `no_session_policy` question.

### 3.2 Actors

`actors` maps a **role alias** used in the graph (`lead_creator`,
`approver`) to a **persona id** from `personas.json`. The persona is the
role as the test cases name it; it names the **account** it logs in as, and
the account decides the credentials (env names derived from its id:
`SF_<ACCOUNT>_USERNAME/_PASSWORD`, optional `_TOKEN`/`_TOTP_SECRET`), the
site (org vs portal vs Siebel) and the **auth method**
(`frontdoor | singleaccess | ui`). Several roles may share one account
(`docs/DESIGN-ROLES-ACCOUNTS.md`). Two aliases may point at one persona;
an alias whose persona is not in the roster raises `role_unbound`. A graph
never names an account or an env var — only the role.

### 3.3 Persona matrix — `alternatives`

Two readings of an ADO pre-req like *"Personas who can perform this
action: Client Associate, Client Lead, BDM…"*. The DEFAULT reading is a
**chain of hand-overs** — the role names say what each does, so model one
session per persona in process order (`lead_to_customer` is the reference:
creator → approver → credit check → customer approver). Only when the list
means "any ONE of these may do it" is it a **permission claim** — then ONE
session bound to the first persona plus the matrix:

```jsonc
"actors":       { "client_associate": "client_associate", "billing_collections": "billing_collections" },
"alternatives": { "client_associate": ["client_lead", "business_development_manager", "business_admin"] }
```

Rules: the alias must exist in `actors`; every id must be in
`personas.json` (else `role_unbound` at `alias:persona`); no duplicates; the
default is not repeated. `expandVariants()` yields the bindings — default
first, then each alternative; several aliases with alternatives combine as
a product, capped at 24 — and the emitted spec runs **one test per
binding** (`… · as client_associate → client_lead`). The run walks the
variant binding but paints and saves the original graph, so the matrix
never leaks into `actors`.

## 4. Nodes

```ts
PNode {
  id, type, label,                     // label required except start/end
  system?, actor?,                     // lanes: sessions REQUIRE system
  account?: { usernameEnv },           // env NAME only
  url?,                                // landing URL / deep link (no creds)
  steps?:    { status: 'planned'|'captured', journeyId?, stepIndexes? },
  snapshot?: { status, ref?, capturedAt? },
  timing?:   { plannedMs?, capturedMeanMs?, capturedP95Ms? },
  catalog?,                            // v1 only
  expects?:  Expectation[],            // §6
  queryable?: boolean,                 // db only
  searchable?: boolean,                // logger only
  endpoint?: { method?, path? },       // api only
  ref?, sobject?, origin?,             // data only — §7
  notes?, pos?: { x, y }
}
```

| type | meaning | must have | typically has |
|---|---|---|---|
| `start` | anchor of the login chain | — (one per graph) | — |
| `end` | terminal | — (one per graph) | — |
| `session` | a SYSTEM × ROLE state: "Salesforce as lead_creator" | `system`; `actor` (the walker refuses a session without one) | `account.usernameEnv`, `url` (landing page → pre-navigation), `steps`, `timing` |
| `screen` | a finer state inside a session (a page/modal) | `label` | `url`, `snapshot`, `expects` |
| `data` | a business record (Lead, Account, Customer in Siebel) — **a runtime variable** | `label` | `sobject`, `expects`, `ref`, `origin` |
| `checkpoint` | a named assertion state | `label`, `expects` | — |
| `db` | a database as evidence source | `label` | `queryable` (default false: most prod DBs are unreachable — verify via API/logs instead) |
| `logger` | a log system as evidence source | `label` | `searchable` |
| `api` | an integration endpoint / hop | `label` | `endpoint { method, path }` |
| `action` `decision` `snapshot` | **v1 only** — do not author | | |

Validator rules on nodes: unique ids; `system`/`actor` must exist in
`systems`/`actors`; `session` requires `system`; `endpoint` only on `api`;
`ref`/`sobject`/`origin` only on `data`; two `data` nodes may not share a
handle (`ref`, default = node id); `sobject` is an SObject API name
(`Account`, `Custom__c`).

## 5. Edges

```ts
PEdge { id, from, to, type, label?, data?: {
  catalog?,                 // does: the step-catalog name  (<noun>.<verb>)
  auth?,                    // login_as: frontdoor | singleaccess | ui
  capability?,              // denied/deny: REQUIRED — what must be refused
  io?, bind?, ioDraft?,     // ports onto data nodes — §7
  recordRef?, deltaMs?, meanMs?, frequency?   // captured timing / v1
} }
```

| type | from → to | semantics | walker |
|---|---|---|---|
| `login_as` | `start`/`session` → `session` | acquire the next session; `data.auth` declares HOW (must agree with the persona's auth in personas.json) | defines the **login chain** = execution order of sessions |
| `does` | `session` → `data`/`screen`/`checkpoint` | the actor performs a step; `data.catalog` names it (`lead.create`); unbound = `plan.<edgeId>` placeholder | a journey step, in **declaration order** within the session |
| `asserts` | `session` → `checkpoint` | evaluate the checkpoint's expectations here | an `assert.<checkpoint>` step |
| `denied` | `session` → any | the role must be REFUSED `data.capability` (UI + API probe) | a deny step |
| `touches` | `session`/`api` → `data`/`db`/`logger` | relation only (who touches what) | none (may carry a port) |
| `handoff` | `data`/`api` → `api`/`data` | an integration hop (SF → Siebel replication) | none (a `produces` port here = ambient definition) |
| `requires` | any → any | prerequisite (seed, permission, another flow) | reported as metadata |
| `next` | `checkpoint`/`session` → `end` | closes the flow | none |
| `navigates` `deny` | **v1 only** | | |

Validator rules on edges: endpoints must exist; `login_as` must land on a
`session`; `denied`/`deny` need `data.capability`; `does` needs
`data.catalog` or at least a `label`; `data.io` only on edges landing on a
`data` node; `bind` only with `consumes`/`updates`, values must contain
`{ref:<handle>.<prop>}`; `auth` must not contradict the persona.

### 5.1 The login chain (execution order)

`start → sessA → sessB → …` via `login_as`, **one linear chain, no
branches, no cycles**. Every `session` must be on it (`chainHealth`:
stranded sessions are amber — a run never reaches them; a branch or cycle is
red). Sessions are ordered by the chain; steps inside a session by edge
declaration order (= drawing order in the planner). A graph that branches
must be split into several graphs (or composed).

## 6. Expectations (what must be true in a state)

```ts
Expectation { id, kind, target?, value?, after?, timeoutMs?, pollMs?, draft?, note?, lastResult? }
```

| kind | target | value | evaluates |
|---|---|---|---|
| `ui.visible` | role/label/text locator | — | element visible on the page |
| `ui.text` | optional locator | expected text (required) | text present |
| `ui.toast` | — | toast text (required) | Lightning toast |
| `ui.url` | — | URL fragment (required) | page URL |
| `api.record_exists` | SObject (required) | — | REST: a record fenced to this run's `E2E_` names exists |
| `api.field_equals` | SObject (required) | `Field=Value` (required) | REST: field on that record |
| `db.query` | a **queryable** `db` node id | query / where (required) | the database |
| `log.traffic` | a **searchable** `logger` node id | search term, e.g. endpoint name (required) | the log system |

- `after`: only check when THIS edge (edge id or its `catalog`) lands on the
  node; omitted = every landing. Use it when one data node collects checks
  from several steps (`lead_created` after `lead.create`, `credit_approved`
  after `credit.check`).
- `timeoutMs` (100…600000) / `pollMs` (≥100, < timeout): backend kinds
  (`api.` `db.` `log.`) **poll**. The default 10 s is right for synchronous
  writes; an async integration (SF → Siebel) needs a budget — the engine asks
  (`api_no_timeout`). UI kinds never poll.
- `draft: true` = machine-guessed (ADO import, capture-first). Confirm or
  remove; a draft is a question, not an assertion.
- `lastResult` is written by merge-back — never author it.

A `data` or `checkpoint` node with no `expects` raises `no_oracles`.

## 7. Data flow — ports, handles, definitions

A `data` node is a **runtime variable**. Its handle is `ref` (default: the
node id); steps receive the record as `{ref:<handle>.id}` (or
`.<Field>` for a seeded field).

| on the edge | meaning | the step receives |
|---|---|---|
| `data.io: "produces"` | this step CREATES the record and publishes its id | `with.produce = <handle>`, `with.sobject`; the runner auto-publishes from the record page the step lands on (`/lightning/r/<SObject>/<id>/view`) or the step calls `ctx.produce()` |
| `data.io: "consumes"` | this step READS the record | `data.bind` (arg → `{ref:…}`) or the default `{ record: "{ref:<handle>.id}" }` |
| `data.io: "updates"` | reads AND changes it | same as consumes |
| no port | legacy: the step receives the node label only | `{ record: "<label>" }` |

`origin` on the data node says who defines it when no step in this graph
does: `step` (default — a `produces` edge must precede every consume),
`seed` (the journey seed block creates it), `external` (a pre-existing record
the run finds by business key). A `produces` edge from a non-session node
(an `api` hop) is an **ambient** definition: consumers get the label +
sobject and must locate the record by business key.

**Rule (reaching definitions, `dataflowHealth`)**: walking the chain, every
`consumes`/`updates` must be preceded by a definition — else **error**
(`data_unproduced`). A second `produces` on a defined node, or a `produces`
on a `seed`/`external` node, is a **warning**. A `does` edge onto a data
node with no port raises `data_no_port`; a machine-guessed port
(`ioDraft: true`) raises `data_io_draft`.

Why: composed graphs (create_customer + add_address) share the `customer`
node; the port is what makes the second flow use the record the first one
created instead of a literal id from capture day.

## 8. Composition (extend a workflow with another graph)

`COMPOSE=<host> COMPOSE_WITH=<sub> npm run graph:compose` or the planner's
**insert ▾**. Copy-merge: the sub's nodes/edges are copied in, provenance in
`composedFrom`. Same-id `data` nodes **merge** (checks unioned) — that is the
join point. Actors/systems must agree by alias/key or compose refuses.

- **island** (default, planner): the sub arrives disconnected and selected;
  draw one `login_as` from a host session into its first session, relink
  `end`. The summary names *which* host session to wire in after (the one
  that produces what the island consumes).
- **splice** (CLI, `COMPOSE_AFTER=` or inferred): sessions merge on
  system+actor+account and the sub-chain splices in after the last host
  session producing what the sub consumes.

## 9. Completeness — the gap engine

`GRILLME=<ref> npm run grillme` prints every gap as a multiple-choice
question (`GAPS_JSON [...]`). A graph is **complete** when only
`not_captured` remains (captures are human work).

| kind | at | question in one line | answer op |
|---|---|---|---|
| `role_unbound` | alias, or `alias:persona` for a matrix alternative | which persona plays this role? (options = personas.json ids) | `bindRole` `{alias, personaId}` · edit `alternatives` for a matrix entry |
| `no_session_policy` | system key | does this system allow concurrent sessions? | `setSessionPolicy` `{system, maxConcurrent}` |
| `draft_oracle` | `node.expect` | keep / edit / remove this machine-guessed check? | `confirmExpect` `{node, id}` · `removeExpect` `{node, id}` |
| `api_no_timeout` | `node.expect` | synchronous (default 10 s) or async budget? | `setOracleBudget` `{node, id, timeoutMs, pollMs?}` (2 min → 120000/5000; 5 min → 300000/5000) |
| `no_oracles` | node | what proves this state is right? | edit the graph JSON: add an `expects` entry (toast → `ui.toast`, text → `ui.text`, record → `api.record_exists`, field → `api.field_equals`) |
| `no_deny_coverage` | graph | is there something a role must NOT be able to do? | `addDeny` `{from, to, capability}` |
| `session_no_url` | session | where does this role start? | `setUrl` `{node, url}` |
| `does_unbound` | edge | name the step (`<noun>.<verb>`) or capture it | `setCatalog` `{edge, name}` |
| `data_io_draft` | edge | keep the guessed port? | `confirmIo` `{edge}` · `setIo` `{edge, io, bind?}` |
| `data_no_port` | edge | does this step create, read, or update the record? | `setIo` `{edge, io, bind?}` |
| `data_unproduced` | edge | where does the record come from? | wire a `produces` edge earlier · `setOrigin` `{node, origin: seed\|external}` |
| `not_captured` | session | (not a question) record it: `RECORD_PERSONA=<persona> RECORD_JOURNEY=<id> npm run record` | — |

Ask cheapest judgment first, in the order above. Write-back is a JSON array
of ops applied with `GRILLME=<ref> GRILLME_APPLY=<ops.json> npm run grillme`
— it validates before saving and prints the change list. **Never edit a
graph in a way the validator would refuse; never invent persona ids.**

## 10. Drafts from imports and captures

- **ADO import** (`import cases` in the planner, or `ADO_FILE=… npm run
  ado:import`): each test case → one graph. `"As <role>, …"` prefixes →
  sessions (alias = slug of the role, flagged `role_unbound`); a pre-req
  step *"Personas who can perform this action: A, B, C"* opens the session as
  the FIRST persona (the rest are listed as alternatives); *"Login with
  '<persona>' persona"* mid-case opens a new session; *"Login … with above
  personas > <action>"* contributes only the action after `>`. Each step → a
  `does` edge, `catalog = <object>.<verb>`; the object noun → a `data` node
  when the expected result says created/saved/exists (or the verb creates);
  the verb → a draft port (`create|convert|submit|add a new` → produces;
  `update|edit|approve|add|delete…` → updates; `open|check|verify` →
  consumes); expected text → a draft oracle (`toast` → `ui.toast`, `url` →
  `ui.url`, created/exists → `api.record_exists`, else `ui.text`). Siebel in
  a role name adds the Siebel system with `maxConcurrent: 1`. Consecutive
  step targets are joined by `next` edges (`e_seq_*`) — a reading ladder so
  the canvas follows the test case top-to-bottom; the walker ignores them.
- **Capture-first** (`PIPELINE_GRAPH=1 npm run pipeline`): one recording →
  sessions per actor, one `does` edge per save-bounded group, data nodes per
  SObject with ports inferred by def-use (the save that created a record
  produces it; later mentions consume), draft oracles.

Everything a machine guessed is either `draft: true`, `ioDraft: true`, or a
flag in the import output — the gap engine turns each into a question.

## 11. A complete minimal graph

```json
{
  "schema": "process-graph/2",
  "id": "create_customer",
  "title": "Create a customer",
  "systems": { "sf": { "label": "Salesforce", "kind": "salesforce", "urlEnv": "SF_INSTANCE_URL" } },
  "actors": { "admin": "admin" },
  "nodes": [
    { "id": "start", "type": "start", "label": "" },
    { "id": "sess_sf_admin", "type": "session", "label": "Salesforce · admin", "system": "sf", "actor": "admin",
      "account": { "usernameEnv": "SF_ADMIN_USERNAME" }, "url": "/lightning/o/Account/list" },
    { "id": "customer", "type": "data", "label": "Customer record", "sobject": "Account",
      "expects": [
        { "id": "customer_created", "kind": "api.record_exists", "target": "Account", "after": "cust.create", "timeoutMs": 10000 },
        { "id": "saved_toast", "kind": "ui.toast", "value": "was created", "after": "cust.create" }
      ] },
    { "id": "end", "type": "end", "label": "" }
  ],
  "edges": [
    { "id": "e1", "from": "start", "to": "sess_sf_admin", "type": "login_as", "data": { "auth": "frontdoor" } },
    { "id": "e2", "from": "sess_sf_admin", "to": "customer", "type": "does", "label": "create customer",
      "data": { "catalog": "cust.create", "io": "produces" } },
    { "id": "e3", "from": "sess_sf_admin", "to": "customer", "type": "denied", "label": "must NOT delete",
      "data": { "capability": "cust.delete" } },
    { "id": "e4", "from": "customer", "to": "end", "type": "next" }
  ]
}
```

Its only remaining gap is `not_captured` for `sess_sf_admin`. Note the
explicit `timeoutMs` on the backend check: an *answered* budget (even the
default 10 s) is what closes `api_no_timeout`.

## 12. Authoring checklist ("done" means)

1. `validateGraph` ok (the planner's **check** badge, or `npm run grillme`).
2. One `start`, one `end`, one linear `login_as` chain reaching every
   session; every session has `system`, `actor`, and ideally `url`.
3. Every role alias bound to a real persona id; `auth` on `login_as` agrees
   with that persona.
4. Every `does` edge has a `catalog` (or is queued for capture).
5. Every `does` edge onto a `data` node has a port; every consume has a
   definition before it (`dataflowHealth` clean).
6. Every `data`/`checkpoint` node has at least one confirmed (non-draft)
   expectation; backend checks on async integrations carry a budget.
7. Non-Salesforce systems declare a session policy.
8. Multi-role graphs have at least one `denied` edge (the security half).
9. A "personas who can perform this" pre-req is either a chain of
   hand-overs (one session each, the default) or a matrix (`alternatives`)
   — decided with the human; every persona in the roster.
10. `GRILLME=<ref> npm run grillme` reports only `not_captured`.
