# STUDY — Representing multi-role, multi-system Playwright suites as graphs

*2026-08-31, prompted by owner review of the planner: "in my mind the edges are
relations — start → login as → sf". Verdict up front: that intuition matches
the strongest tradition in the field, and process-graph v2 should adopt it.*

## 1. Four traditions, what each gets right

**Activity graphs (BPMN / process mining — what v1 does).** Nodes are actions;
edges are mere sequence. Right for: showing what happened, frequencies, timing
(the captured-DFG view). Wrong for us: *who you are and where you are* — the
heart of multi-role/multi-system testing — live as node attributes, sessions
are invisible, login is just another box, and prerequisites have no shape.

**Model-based testing (GraphWalker / FSM / statecharts).** The doctrine, per
GraphWalker: an **edge expresses an action** with the system under test
(a click, an API call, a login); a **vertex expresses a state** which should
be tested — "verification is going on only in the vertex, never on the edge."
Plus two load-bearing extras: **guards** (a precondition that makes an edge
eligible — an if-statement on the walk) and **generators** (algorithms that
walk the graph to produce test paths — the 40-60% authoring-reduction lever).
This is exactly the owner's mental model.

**Property-graph triples (subject → predicate → object).** Every edge is a
typed relation: `start —login_as→ sf·sales_user`. This is the queryable
ontology form — and it maps 1:1 onto the MMPM substrate's edge grammar, so
"which processes log into Siebel as admin" becomes a memory query for free.

**Prerequisite DAGs (Airflow / Playwright project dependencies).** Tasks run
only after their prerequisites; graphs must stay acyclic; setup is a
first-class dependency (Playwright's own `dependencies: ['setup']` is this).
Right for: cross-journey ordering, data seeding, permission grants — the
"Given" of Gherkin's Given/When/Then as edges instead of prose.

## 2. Synthesis — the v2 model (state nodes, relation edges)

**Nodes (where/what you are; assertions live here):**
- `start` / `end`
- `session` — a SYSTEM × ROLE/ACCOUNT state: "sf as sales_user",
  "siebel as admin". Carries account env-name; the Cast session policy
  (Siebel max-1) hangs on the system it references.
- `screen` — an optional finer state inside a session: URL/deep link +
  the snapshot slot. (Session lanes stay readable when screens are omitted.)
- `data` — a shared record/entity (today's handoff target, promoted to a node
  so several sessions can relate to one record).
- `checkpoint` — a named assertion state (MBT: verify in vertices).

**Edges (what you do / how things relate; typed relations):**
- `login_as` — start/session → session; THE owner example. Carries auth kind
  (frontdoor/singleaccess/ui) + account env. Capture maps Cast attach to it.
- `does` — session/screen → screen/checkpoint: the action. Carries step-catalog
  name(s), captured stepIndexes, journeyId, timing (planned + captured
  mean/p95), settle family. What v1 stored in action NODES moves here.
- `navigates` — folds into `does` (a does whose catalog is nav.*).
- `requires` — prerequisite relation (guard): data seeded, another subgraph
  green, permission present. Exports to Playwright project dependencies /
  seed blocks; acyclicity enforced.
- `touches` / `hands_off` — session/does ↔ data: who creates, who consumes;
  cross-session hand-off is two `touches` on one data node (clearer than one
  jump edge).
- `denied` — the negative capability probe as a guarded edge that MUST refuse
  (UI + API), keeping the anti-gaming half first-class.
- `asserts` — does/session → checkpoint.

**Why this wins for capture-and-stitch:** the recorder already produces
"authenticated session, then a stream of actions" — that is literally
`login_as` then `does` edges; stitching = joining sessions on shared `data`
nodes; deny recordings = `denied` edges; path generation over the same graph
later YIELDS journey variants (GraphWalker generators) instead of hand-writing
them; and every edge is a substrate-ready triple.

## 3. What changes, concretely — SHIPPED 2026-08-31 (suite 224 green)

| Item | Change |
|---|---|
| G2-0 | `process-graph/2` schema (nodes/edges above) + validator; v1→v2 auto-converter (v1 action node → `does` edge; lane change → inferred `login_as`; deny edge → `denied`; handoff → `data` node + `touches`) |
| G2-1 | planner v2: lanes = sessions; palette per edge TYPE; edge-first editing (select an edge → its relation form); dual-load v1/v2 |
| G2-2 | `fromDistillation` v2 writer (Cast attach → login_as; steps → does; ids → data nodes) |
| G2-3 | `toJourney` v2 walker (walk does/login_as spine; requires → project deps + seed; denied → deny steps) |
| G2-4 | substrate encoding v2: edges as triples under hub_sf_journeys |

Estimated one working session. v1 files keep loading forever (converter).

## 4. Panel findings (applied immediately, v1.1 — schema-neutral)

Owner expectation, implemented 2026-08-31: a node leads with **URL · role/user
(actor → persona, account env) · START CAPTURE · snapshot**, and everything
else collapses behind "more details". START CAPTURE generates and copies the
exact recording command for that node's persona and graph
(`RECORD_PERSONA=… RECORD_JOURNEY=… npm run record`) — the planner is the
capture COCKPIT, not a form. (True one-click launch needs a local companion
process — candidate for the recorder watch-mode phase.)

## Sources

- GraphWalker doctrine (vertex=state, edge=action, guards, generators):
  graphwalker.github.io · github.com/GraphWalker (gw_model_syntax) ·
  altom.gitlab.io/altwalker (modeling) · gw4e.github.io (nutshell) ·
  ontestautomation.com (GraphWalker + Selenium)
- Prerequisite DAG practice: reintech.io (testing Airflow DAGs) ·
  sparkcodehub.com (DAG dependencies, cross-DAG) · Terraform DAG ordering
  (dev.to) — plus Playwright's own project-dependencies mechanism
- Prior study (§ OCEL/DFG, editor landscape): docs/DESIGN-PROCESS-GRAPH.md
