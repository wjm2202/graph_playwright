# STUDY — Data flow between nodes: what the code does, what the science says

*2026-09-02. Prompted by: "create_customer + add_address — how does the customer
get from one node to the next, and should the edge carry it?" Verdict up front:
**not solved today.** The graph has a join POINT (the `data` node) but no data
CONTRACT (who produces it, who consumes it, what runtime handle carries it).
The fix is small and fits the v2 model: keep auth where it is, put an
in/out **port** on edges that touch `data` nodes, bind the `data` node to the
runtime `refs` map, and let the recorder infer the ports by def-use analysis.*

## 1. What the code says today (source-verified)

| Question | Answer | Where |
|---|---|---|
| Where do values live at run time? | One map, `refs: RefMap` (`ref → {id, sobject, fields}`), created by the journey `seed` block. | `journeys/runner.ts:140-144`, `data/seed.ts` |
| Who writes to `refs`? | **Only `seedRecords()`.** No step, no oracle, no catalog entry ever writes to it (grep `refs[…] =` → one hit, seed.ts). | `data/seed.ts:117,123`, `runner.ts:213-227` |
| How does a step read a value? | `with` args pass through `resolvePlaceholders` — `{ref:customer.id}`, `{unique:}`, `{fake:}`, `{runId}`. Forward refs throw. | `data/seed.ts:47-85` |
| What does the graph emit into `with`? | For a `does` edge landing on a `data` node: `with.record = node.label` — the human LABEL ("Customer record"), not a reference. | `graph/toJourney.ts:193` |
| What do `touches` / `handoff` edges do at run time? | Nothing. They are relations for the picture and the substrate; the v2 walker skips them. | `toJourney.ts:186-227`, `compose.ts:152-176` |
| What does capture do with record ids? | Harvests them (`harvestedIds`, first-seen event index) and leaves them **literal** in step args, with a flag: "parameterize when seed provenance is known (sprint S1)". | `pipeline/distill.ts:96-104, 171-177` |
| So what happens on replay? | `recordPage.open` does `page.goto('/lightning/r/'+sobject+'/'+id+'/view')` with the id recorded on capture day. | `journeys/generated/fixture_demo.steps.ts:11-13`, `pipeline/generate.ts:226-228` |
| What does compose do with data? | Merges same-id `data` nodes (unions their `expects`) in both island and splice mode. Sessions merge only in splice. | `graph/compose.ts:256-273` |
| What does ADO import know? | The object noun (`OBJECT_RE`) and the verb (`verbOf`) of every step; it already routes "created/exists" steps to a `data` node. | `graph/fromAdo.ts:118, 185-205, 305` |
| What does grillme ask about data? | Nothing. `GapKind` has no data-flow gap. | `graph/gaps.ts:14-23` |

**Concrete failure, create_customer + add_address.** Compose merges the two
`customer` data nodes — good, that is the join point. But the walk emits
`cust.create` then `address.add` with `with: { record: 'Customer record' }`
on both; the captured `address.add` slice replays `recordPage.open` with the
literal id from the recording; the customer created seconds earlier is never
used. The graph *looks* joined and the test runs against the wrong record.

**Where auth lives is already right.** `login_as` edge declares *how* the
session is acquired (`data.auth`), the `session` node declares *who/where*
(system × actor × account env). personas.json decides; the validator catches
disagreement (`schema.ts:312-331`). Nothing to move.

## 2. What the science says

Four traditions answer "how do nodes hand each other data", and they agree.

**Dataflow / process networks (Kahn 1974; Lee & Parks 1995).** Nodes are
actors, **edges are channels that carry tokens, and the interface between an
actor and a channel is a port.** A data dependency is formally the triple
*(producer node, datum, consumer node)*. Ordering is a *consequence* of data
dependencies — you do not draw "next" separately from "needs". This is the
owner's instinct ("use the edge to show what data is passed") stated as a
model of computation.

**Workflow languages (CWL, WDL, Argo).** The industrial form of the same
idea. Every step declares typed `inputs` and `outputs`; a step input's
`source: producer/output` **is** the edge; the DAG is derived from those
sources; a workflow cannot be validated with an unsatisfied input. Argo's
`{{steps.create.outputs.parameters.id}}` is exactly our `{ref:customer.id}` —
we already have the placeholder syntax, we lack the declaration that makes
the resolver's job automatic.

**Model-based testing (GraphWalker).** Our v2 doctrine (vertex = state, edge
= action) — and its known hole: models compose via *shared vertices*, but
**"the scope of the data in the models is not shared between them"**
(GraphWalker issue #174, still open). Composing two models on a state and
then discovering the second cannot see the first's variables is precisely
the create_customer + add_address failure. The literature's fix is the
dataflow one: make the shared thing a *data* vertex with a declared binding,
not just a control-flow join.

**Object-centric process mining (OCEL 2.0).** Events relate to *objects*
(the Lead, the Account); an object's lifecycle across many actors is the
first-class trace. Our `data` node is an OCEL object. The recording already
knows which event first mentions an id and which later events mention it
again — that is a **def-use chain** (reaching definitions, the classic
compiler data-flow analysis): one *definition* (the step after which the id
first appears in a URL/response) and n *uses* (every later step whose args
contain it). Inferring the ports from a capture is that analysis, not a
heuristic.

**Playwright itself** confirms the runtime side: parallel tests share no
state; project `dependencies` order work but pass nothing; the sanctioned
channel for a created-record id is a fixture value or an explicit handoff
inside one serial run. Our runner is that serial run; `refs` is the fixture.
The missing piece is purely *declarative*.

## 3. Proposal — ports on edges, binding on data nodes (process-graph/2, additive)

### 3.1 Schema (three optional fields; every existing graph stays valid)

```ts
// data node — becomes a runtime variable, not just a picture
interface PNode {                       // type: 'data'
  ref?: string;        // runtime handle; default = node id  → {ref:<ref>.id}
  sobject?: string;    // 'Account' — lets the oracle + seed agree on the object
  origin?: 'step' | 'seed' | 'external';  // who is expected to DEFINE it
}

// edges that touch a data node — the PORT
interface PEdge { data?: {
  io?: 'produces' | 'consumes' | 'updates';   // does/touches/handoff → data
  bind?: Record<string, string>;              // arg name → '{ref:customer.id}'
} }
```

Read as triples the way the substrate does:
`sess_admin —does[cust.create, produces]→ customer` ·
`sess_admin —does[address.add, consumes id]→ customer`.

`bind` is the explicit port map when the step's arg name differs from the
default; the default for `consumes` is `{ record: '{ref:<ref>.id}' }`, which
replaces today's `with.record = label`.

### 3.2 Validation (schema.ts + a `chainHealth`-style dataflow check)

Reaching-definitions over the run order (`runOrder()` already exists):

- every `consumes`/`updates` edge must be preceded, in walk order, by a
  `produces` edge on the same data node, a `seed` entry with that `ref`, or
  `origin: 'external'` (find-or-create) — else **error: use-before-def**;
- a `produces` on a node already produced → warning (re-create?);
- a data node nobody consumes → info (dead value — fine, it may be the point).

This is the check compose is missing: in island mode the stranded
`address.add` edge shows as amber today for its *session*; with ports it
also shows **"consumes `customer` — nothing produces it before this point"**
until the human wires it after `cust.create`. In splice mode `after` can be
*inferred* — the latest session that produces everything the sub consumes —
which is the "automatically know" the owner asked for.

### 3.3 Runtime (runner.ts + catalog.ts)

- `StepCtx` gains `produce(ref: string, rec: { id: string; sobject?: string; fields?: … })`
  → the runner writes it into `refs` (the first non-seed writer). One line
  in the runner; the same `RefMap` type; forward-ref errors already exist.
- `toJourneyV2` emits `with` from the port: `produces` → nothing extra
  (the step implementation calls `produce`); `consumes` → `bind` or the
  default `{ record: '{ref:customer.id}' }`.
- Generated composite steps (`slice.ts` replay) get a post-step hook: if the
  edge is `produces`, harvest the id from the landing URL
  (`RECORD_URL_RE`, already in distill) and `produce()` it.

### 3.4 Capture → ports automatically (distill.ts + fromCapture.ts)

The recorder already has `harvestedIds[{id, sobject, firstEvent}]`. Add the
def-use pass:

1. **def** = the step group whose *boundary save* immediately precedes the
   id's `firstEvent` (the create that produced it) → that `does` edge gets
   `io: 'produces'`, the data node gets `sobject`;
2. **use** = every later step whose args contain the id → its edge gets
   `io: 'consumes'`, and the literal in `args` is rewritten to
   `{ref:<node>.id}` (this retires the "literal record id — parameterize
   later" flag; it was waiting for exactly this provenance);
3. an id with uses but no def in the recording → `origin: 'external'` +
   a `seed`/`findBy` draft, flagged for grillme ("this record pre-existed —
   seed it, or find it by name?").

### 3.5 ADO import + manual authoring

- **fromAdo**: `verbOf()` already yields the verb. Map `create|convert|
  submit` → `produces`; `update|edit|approve|progress` → `updates`; `open|
  check|verify` → `consumes`. All draft, flagged.
- **gaps.ts**: new kinds `data_unproduced` ("Step X uses the Customer — is it
  created earlier in this graph, seeded, or found by name?"), `data_io_draft`
  ("Machine-guessed: 'create customer' PRODUCES Customer record — keep?").
  grillme asks them right after `draft_oracle`.
- **planner**: the `does`/`touches` edge form gets an *in / out / update*
  radio when the target is a `data` node; a consumes edge with no upstream
  producer is drawn amber (same referee pattern as stranded sessions).

### 3.6 Tests (the discipline: every piece above lands with its spec)

`tests/unit/graph-dataflow.spec.ts`: validator accepts legacy graphs
unchanged; use-before-def errors; seed and `external` satisfy a consume;
compose island reports the unproduced consume; compose splice infers
`after`; `toJourneyV2` emits `{ref:customer.id}` for a consume; runner
`produce()` lands in `refs` and a later `{ref:}` resolves; distill def-use
rewrites a harvested id to `{ref:}` and flags an external id; fromAdo verb →
io mapping. Harness: planner edge form round-trips `io`.

## 4. Decisions (LOCKED by owner, 2026-09-02 — "take the recommendation")

- **D1 — port on the edge.** ✅ `data.io` on the edge; the node keeps identity
  only (`ref`, `sobject`, `origin`).
- **D2 — infer `after` from data deps in splice mode.** ✅ Island stays the
  default; its summary now says *which* host session to wire in after.
- **D3 — validator + emission first, runtime second.** ✅ Both shipped in the
  same session, in that order.

## 5. Shipped 2026-09-02 (suite 481 green · typecheck · lint clean)

| Piece | Where | Pinned by |
|---|---|---|
| Schema: `ref`/`sobject`/`origin` on data nodes; `io`/`bind`/`ioDraft` on edges; validation | `src/graph/schema.ts` | `tests/unit/graph-dataflow.spec.ts` (schema) |
| `dataflowHealth()` — reaching definitions over the login-chain walk; ambient (api→data) definitions; re-produce + origin warnings; `definedBy` map | `src/graph/compose.ts` | (dataflowHealth) |
| Compose: island summary names the producer to wire after; splice infers `after` (`inferSplicePoint`) | `src/graph/compose.ts` | (compose) |
| Walker: produces → `with.produce`/`sobject`; consumes/updates → `bind` or `{ record: '{ref:<ref>.id}' }`; integration-created records → label + sobject with a warning; dataflow errors surface as warnings | `src/graph/toJourney.ts` | (toJourneyV2 emission) + `graph-v2.spec.ts` |
| Runtime: `StepCtx.produce()`; runner auto-publishes a `produces` step from the record page it landed on, fails loudly on nothing / wrong object | `src/journeys/catalog.ts`, `runner.ts`, `src/utils/recordUrl.ts` | (runner — produce()) |
| Capture def-use: `inferDataflow` — save defines, redirect nav → `recordPage.landed` (publishes), later uses → `{ref:}`, external stays literal; numbered handles | `src/pipeline/distill.ts`, `generate.ts` | (capture — def-use) |
| Stitch unification across recordings: creator owns the handle, others' literals rewritten, handle collisions numbered | `src/pipeline/stitch.ts` | (stitch tests) |
| Capture-first graph ports per group (`portFor`) + `sobject`/`origin` on data nodes | `src/graph/fromCapture.ts` | (capture-first graph tests) |
| ADO: `verbIo()` verb → draft port; steps on a known object land on its data node | `src/graph/fromAdo.ts` | (ADO import) |
| grillme: gap kinds `data_io_draft`, `data_no_port`, `data_unproduced`; ops `setIo`, `confirmIo`, `setOrigin` | `src/graph/gaps.ts` | (grillme) |
| Planner: port selector on edges onto data nodes, port glyph on the edge label (⇒ out / ⇐ in / ⇔ upd), dataflow errors in the check panel | `tools/planner-src.html`, `build-planner.mjs` | `tests/harness/planner.spec.ts` |
| Shipped graphs carry ports (`expense_to_siebel`, `lead_to_customer`) | `journeys/graphs/` | drift guard + `graph-v2.spec.ts` |

**Not done / follow-ups:** the `/grillme` skill's ask-order should add the
three data questions right after `draft_oracle` (skill text lives in the
Cowork account, not the repo); `requires` edges are still metadata only;
`bind` has no planner UI yet (JSON-only — the default `{record}` covers the
common case).

## Sources

- Kahn process networks / dataflow process networks: Lee & Parks, *Proc. IEEE* 1995 — bears.ece.ucsb.edu/class/ece253/papers/lee_parks_ieee95.pdf · sciencedirect.com/topics/computer-science/kahn-process-network · port-based actor model — researchgate.net/publication/257672388
- Data-dependency edge as (producer, datum, consumer) triple; control/data-dependency test selection: researchgate.net/publication/221030071 · arxiv.org/pdf/1807.09899 (YesWorkflow schema-level data-dependency annotations)
- CWL `WorkflowStepInput.source` / `outputSource`: commonwl.org/v1.2/Workflow.html · commonwl.org/user_guide/topics/workflows.html
- Argo output → input parameters `{{steps.X.outputs.parameters.Y}}`: argo-workflows.readthedocs.io/en/latest/walk-through/output-parameters/
- GraphWalker shared vertices but no shared data between models: github.com/GraphWalker/graphwalker-project/issues/174 · groups.google.com/g/graphwalker/c/jhc2rvZW2fI · docs.getxray.app (MBT with GraphWalker)
- Playwright: no state across workers, serial/fixtures as the handoff channel: playwright.dev/docs/test-parallel · playwright.dev/docs/test-fixtures · github.com/microsoft/playwright/issues/24504
- Prior studies in this repo: DESIGN-PROCESS-GRAPH.md (OCEL 2.0, DFG), STUDY-TEST-GRAPH-REPRESENTATION.md (GraphWalker doctrine → v2)
