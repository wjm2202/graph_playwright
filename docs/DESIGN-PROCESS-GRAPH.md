# DESIGN — Process Graphs: plan → capture → relate

> **Status (2026-09-03): design history.** The model this proposed shipped as `process-graph/2` and is specified in [GRAPH-SPEC.md](GRAPH-SPEC.md). What has since gone: the v1 activity-node form (`action`/`decision`/`snapshot` nodes, `navigates`/`deny` edges — a v1 file still opens, upgraded at the load door), the Mermaid and batch exporters, and the first planner (`tools/process-planner.html`), replaced by the Journey Script Planner in `tools/planner-v2/`. The decisions here still hold; read the spec for the mechanism.

*Research + proposal, 2026-08-31. Status: for discussion — decision points at the
end. Extends docs/multi-actor-orchestration-design.md and sprint S-REC.*

## 1. Problem

Journeys increasingly cross SYSTEMS, not just personas: Salesforce → Siebel →
other downstream apps. That adds three needs the journey JSON alone doesn't
carry well:

1. **Planning context BEFORE capture** — a human wants to sketch the process
   (who, on which system, doing roughly what, in what order) as a graph, so the
   recorder session has a script and the captured steps have somewhere to land.
2. **System constraints** — Siebel allows ONE session at a time. That's a
   scheduling fact the runner must respect; it belongs on the graph's system
   node, not in someone's head.
3. **Relations after capture** — actions, navigations, timing, shared records,
   and actor handoffs are already in the recording; rendered as a graph they
   become reviewable ("who touched what, when, how long, across which apps").

## 2. Research findings (what the field already knows)

**Authoring vocabulary — BPMN-lite, not BPMN.** BPMN is the industry standard
for drawing processes (tasks, gateways, and crucially *lanes* = who/where), but
it is famously ambiguous and heavyweight; Petri nets add formal analyzability
at high modeling cost; statecharts shine for reactive state, not linear
journeys. Verdict: borrow BPMN's lane+task+gateway *vocabulary* on a plain
**typed property graph** (nodes/edges with key-value payloads) and skip the
notational baggage.

**Capture → graph is a solved discipline: process mining.** Event logs →
**directly-follows graphs** (DFG: activities as nodes, "A then B" edges with
frequency + timing) are the standard discovery artifact, and **OCEL 2.0**
(object-centric event logs) handles events that touch multiple objects —
exactly our world: a step involves a persona, a system, and record ids. Our
`Distillation` (steps + timestamps + actors + harvested ids + network) already
IS an object-centric event log in miniature; emitting an (object-centric) DFG
from it is a small pure transform, not an invention.

**Plan-graph → generated tests is a known lever: model-based testing.**
GraphWalker/AltWalker walk directed graphs to generate test paths with coverage
criteria; XState does the statechart flavor. Teams report 40–60% authoring
reduction. We don't build this in v1, but the schema must not preclude it —
the plan graph should eventually GENERATE journey skeletons and path variants.

**Editor tech.** React Flow (@xyflow) is the dominant node-editor library
(~257k weekly downloads), React-native, excellent DX; JointJS is the
enterprise/BPMN-diagram heavyweight; Cytoscape.js is analysis-first rendering;
AntV X6 a smaller editor alternative. All pull in a build stack. For a "very
small compact web view" there is also the zero-dependency route: a single
self-contained HTML+SVG page — hostable as a Claude artifact, versionable in
the repo, and testable with OUR OWN Playwright harness (dogfooding).

## 3. Proposal

### 3.1 The package: `src/graph/` (zero-dep core, extractable later)

TypeScript module in this repo first; publishable as a standalone package once
stable. Pieces:

- `schema.ts` — types + `validateGraph()` (same style as journeys/personas:
  dependency-free, every error at once)
- `fromDistillation.ts` — capture → graph: step DFG with actor lanes, system
  attribution from URL origins, `next` edges carrying gap timing, `navigates`
  edges from nav steps, shared-record `handoff` edges from harvested ids
- `toJourney.ts` — plan graph → journey JSON skeleton(s) + runner constraints
- `mermaid.ts` — graph → mermaid flowchart text (instant rendering anywhere,
  incl. chat artifacts and GitHub)
- `merge.ts` (phase 2) — planned node ↔ captured steps reconciliation

### 3.2 Schema draft (the four data points live on nodes)

```ts
interface ProcessGraph {
  schema: 'process-graph/1';
  id: string;                        // lower_snake_case
  title?: string;
  systems: Record<string, SystemDef>;
  actors: Record<string, string>;    // alias → personas.json id
  nodes: PNode[];
  edges: PEdge[];
}

interface SystemDef {
  label: string;
  kind: 'salesforce' | 'siebel' | 'web' | 'api' | 'other';
  urlEnv?: string;                   // env-var NAME (never a URL literal w/ creds)
  sessionPolicy?: { maxConcurrent: number };   // Siebel: { maxConcurrent: 1 }
}

type PNode = {
  id: string;
  type: 'start' | 'action' | 'decision' | 'checkpoint' | 'snapshot' | 'end';
  label: string;
  system?: string;                   // SystemDef key  → lane (x)
  actor?: string;                    // actor alias    → lane (y)
  account?: { usernameEnv: string }; // user account — env NAME only
  url?: string;                      // application URL / deep link (or urlEnv)
  steps?: {                          // placeholder until captured
    status: 'planned' | 'captured';
    journeyId?: string;              // filled by the pipeline
    stepIndexes?: number[];
  };
  snapshot?: {                       // a place for a snapshot
    status: 'planned' | 'captured';
    ref?: string;                    // file path or dataURL
    capturedAt?: string;
  };
  timing?: { plannedMs?: number; capturedMeanMs?: number; capturedP95Ms?: number };
  notes?: string;
};

type PEdge = {
  id: string;
  from: string;
  to: string;
  type: 'next' | 'navigates' | 'handoff' | 'deny';
  label?: string;
  data?: {
    deltaMs?: number;               // captured gap between steps
    recordRef?: string;             // shared record joining two actors/systems
    frequency?: number;             // DFG aggregate mode
  };
};
```

Rules mirror the repo's discipline: env-var NAMES only (the personas.json
secret-smell guard is reused), ids lower_snake_case, validation loud.

### 3.3 Capture → graph (the free half)

`fromDistillation(stitched, { systemByOrigin })` emits:
- one `action` node per distilled step (label = catalog + args summary),
  `actor` from the stitch alias, `system` from the step URL origin (nav steps)
  or the lane's last-known system,
- `next` edges with `deltaMs` = gap between consecutive steps (the timing view),
- `navigates` edges for `recordPage.open`/`nav.goto`,
- `handoff` edges when a harvested record id crosses actors/systems (the R6
  cross-actor flags, upgraded to first-class edges),
- optional **DFG aggregate mode**: collapse repeated catalog activities into
  one node with frequency + mean/p95 (classic process-mining view; feeds on
  the same numbers baselines use).

### 3.4 Plan → execution (the context half)

- `toJourney()` walks `next` edges per actor lane → journey JSON skeleton with
  empty `with` blocks and `steps.status: 'planned'` back-references — the
  recorder session then fills them (`npm run record` per lane).
- **Session policies enforce Siebel-style limits**: the runner gains a
  per-system mutex — steps whose node's system has `maxConcurrent: 1` are
  serialized (Cast keeps one live context per system; entering a locked system
  releases-or-waits). v1 = in-process lock (single runner); cross-worker
  brokering stays Option C.
- `deny` edges map to journey deny steps (the anti-gaming half carries over).

### 3.5 The compact web view (planner v0) — AMENDED 2026-08-31

**Engine decision (research round 2): Cytoscape.js core + the official
edgehandles extension + dagre layered layout, inlined into ONE self-contained
`tools/process-planner.html`.** Still zero BUILD step (D1's intent) — the
library ships as UMD text inside the file (~400KB total, artifact-safe), so
the deliverable remains a single file that opens anywhere.

Why this beats both the hand-rolled SVG editor and mermaid:
- **Graph-native for free**: nodes/edges/selection/pan/zoom/hit-testing/
  styling/layout are first-class Cytoscape concepts — we write glue and the
  side-panel form, not graph machinery. Hand-rolled SVG would spend the whole
  budget rebuilding exactly that, worse.
- **One page, three modes**: `edit` (define/update a plan), `view` (read-only,
  pan/zoom), `captured` (render a pipeline-emitted graph with timing on
  edges). Same file, same styling, same JSON contract — view + update + define
  in a native graph representation, for any user.
- **Auto-layout built in**: dagre's layered layout is the canonical process /
  directly-follows look, and captured graphs NEED auto-layout (no human placed
  those nodes). fcose available for organic views later.
- **Editing**: edgehandles (maintained by the cytoscape org) gives
  drag-from-node-to-node edge creation; double-click empty canvas adds a node;
  the four data points (account env, app URL, steps placeholder, snapshot
  paste→dataURL) stay in an HTML side panel — forms belong in HTML, not canvas.
- **Mermaid demoted to what it is**: a ~40-line static EXPORT for GitHub/docs/
  chat rendering. Not the system, kept because it's nearly free. The system is
  `.graph.json` + this page.

Rejected: vis-network (built-in editing but maintenance-mode, weak styling),
Drawflow (dataflow in/out-port model ≠ process lanes), LiteGraph (Unreal-
Blueprints aesthetic, wrong audience), JointJS+ (paid tier owns the BPMN
goodies), React Flow now (build stack + can't be a single artifact file;
remains the upgrade path — cytoscape also embeds in React if we ever lift it).

Dogfooding unchanged: our own harness drives the planner (add node, connect,
form round-trip, import/export, mode switching).

### 3.6 Storage & substrate

- Repo: `journeys/graphs/<id>.graph.json` (git-diffable, next to journeys).
- Substrate: a graph checkpoints naturally onto MMPM — the substrate IS a
  property graph. Pattern: `v1.procedure.process_<id>__graph` (payload =
  compact JSON) + `v1.fact.process_<id>__coverage` (systems/actors/records
  touched) under `hub_sf_journeys`, edges to the journeys it generated —
  making "which processes touch Siebel with persona X" a memory query.
  (Same review-then-publish rule as settle contracts.)

## 4. Build plan — EXECUTED 2026-08-31 (one session, suite 202 green)

| Item | Status | Shipped as |
|---|---|---|
| PG-0 | ✅ | `src/graph/schema.ts` (+ 8 validation tests; shipped seed graph drift-guarded) |
| PG-1 | ✅ | `src/graph/fromDistillation.ts` (per-step + aggregate DFG) + `mermaid.ts` (6 tests incl. fixture integration) |
| PG-2 | ✅ | `tools/process-planner.html` (803KB single file: cytoscape+edgehandles+dagre+shared schema inlined by `npm run build:planner`) — 10 harness tests drive it over file:// |
| PG-3 | ✅ | `src/graph/toJourney.ts` (spine walk incl. handoff, deny-edge mapping, plan.* placeholders, policy derivation) + Cast `sessionPolicies` logout-to-comply LRU (9 tests; Siebel max-1 proven with real contexts) |
| PG-4 | ✅ | `src/graph/toBatch.ts` (validator-clean atoms, dataURL/pos/notes stripped, 4096 cap enforced; 6 tests) + seed `journeys/graphs/expense_to_siebel.graph.json` |
| PG-5 (later) | — | merge captured↔planned; MBT path generation; React Flow upgrade; CDP-snapshot per node |

Notes from execution: `handoff` joined the sequencing spine (a record crossing
actors IS the handover); planner build inlines the SAME transpiled schema.ts
the suite tests, so web-view validation can never drift from the package.

## 5. Decisions (LOCKED by owner, 2026-08-31)

- **D1 — editor tech**: ✅ zero-BUILD v0 single-file planner; **amended
  2026-08-31 after engine research: powered by inlined Cytoscape.js +
  edgehandles + dagre (§3.5)** — less code than hand-rolled SVG, real graph UX.
  React Flow stays the upgrade path only.
- **D2 — where the planner lives**: ✅ repo file + a published artifact copy;
  graphs save as repo `.graph.json`. *(2026-09-03: that file is now
  `tools/planner.html`, built from `tools/planner-v2/` — the Journey Script
  Planner replaced this one, see `docs/PLANNER-FEATURE-PARITY.md`.)*
- **D3 — capture-graph emission**: ✅ ON DEMAND only — a dedicated flag/command
  (e.g. `npm run pipeline:graph` or `PIPELINE_GRAPH=1`), NOT on every run.
- **D4 — Siebel session policy**: ✅ v1 in-process per-system mutex in the
  runner, driven by `systems.<id>.sessionPolicy.maxConcurrent`; cross-worker
  brokering stays deferred to Option C.

## Sources

- BPMN↔Petri-net transformation & analysis: journals.sagepub.com/doi/10.1177/1687814018808170 · arxiv.org/pdf/2311.05243
- Statecharts vs BPMN/Petri for execution: sciencedirect.com/science/article/pii/S2096720925001484
- OCEL 2.0 spec: arxiv.org/pdf/2403.01975 · OC-PM: link.springer.com/article/10.1007/s10009-022-00668-w
- Object-centric DFGs: link.springer.com/chapter/10.1007/978-3-032-02929-4_12 · vdaalst.rwth-aachen.de/publications/p1398.pdf
- GraphWalker MBT: github.com/graphwalker · docs.getxray.app (AltWalker MBT)
- Editor landscape: synergycodes.com/blog/react-flow-vs-jointjs-react-wrapper · radar.firstaimovers.com/react-flow-vs-cytoscape-graph-engine-choice · npmtrends.com (@antv/x6 vs react-flow)
