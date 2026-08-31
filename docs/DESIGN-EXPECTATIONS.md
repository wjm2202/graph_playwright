# DESIGN — Expectations: pass/fail oracles on the graph

*2026-08-31. Owner question: "each node could be pass or fail — how does the
graph represent that, and how does it translate to asserts?" Formal name: the
TEST ORACLE problem. Shipped as expectations v0 the same day.*

## 1. Grounding (graph domain × Playwright domain)

- **MBT doctrine** (already our foundation): verification happens in VERTICES;
  edges act. The literature adds two teeth: *state invariants in the model are
  the test oracle*, and *oracle placement matters* — asserting at each reached
  state detects faults that a single end-of-journey check can mask, because a
  corrupted state can look repaired later.
- **Playwright domain**: web-first auto-retrying assertions on app-visible
  state (visible/text/url/toast) are the UI half; our own corpus mandates the
  second half — `ui_only_assertions__sufficient__false`: the UI says it
  happened, the org proves it happened (SOQL/API). Denials are the negative
  oracle and already exist as `denied` edges. Timing oracles already exist as
  baselines.

## 2. The model: `expects` on state nodes

Every state node (`session`, `screen`, `data`, `checkpoint`) may carry a list
of typed expectations — *what must be true in this state*:

```ts
interface Expectation {
  id: string;                    // lower_snake, unique per node
  kind: 'ui.visible' | 'ui.text' | 'ui.toast' | 'ui.url'
      | 'api.record_exists' | 'api.field_equals';
  target?: string;               // ui.*: role/label/text target · api.*: SObject
  value?: string;                // expected text/url; api.field_equals: "Field=Value"
  /** Oracle placement: only checked when THIS edge (id or catalog) lands on
   *  the node. Omitted = checked at every landing. */
  after?: string;
  note?: string;                 // the human phrasing of the acceptance criterion
  lastResult?: { status: 'pass' | 'fail'; at: string; runId?: string; message?: string };
}
```

`after` solves multi-phase data nodes: the Lead record expects
`record_exists` after `lead.create`, `Status=Potential` only after
`lead.progress_to_potential` — same node, different oracles per landing.

**Pass/fail representation**: `lastResult` per expectation (one snapshot,
overwritten by the merge-back step — run history stays in report files, per
the storage-split rule). Node aggregate derives: any fail → red border; all
pass → green; none run → neutral. The planner paints it and badges the label
(`✓ 2 checks` / `✗ 2 checks`).

## 3. Translation to asserts (journey emission)

- A `does` edge landing on a node with matching expectations emits them into
  that step's `expect` block — the runner already pipes `ctx.expects` into
  every step implementation, so implementations (and the generated vocabulary,
  next) assert them right after acting. UI kinds compile to
  `expect(locator).toBeVisible()/toContainText()/toHaveURL()` + toast checks;
  api kinds compile to SalesforceApi/SOQL probes — the dual layer.
- A `checkpoint` node reached via an `asserts` edge emits an explicit
  `assert.<node_id>` step for the asserting session's actor, carrying the
  checkpoint's expectations (listed as unbound until a catalog entry exists).
- `denied` edges remain the must-fail oracle; baselines remain the timing one.

## 4. Planner

Node panel gains **what to test**: rows of kind/target/value (+ note via
title), add/remove, with a pass/fail dot per row once results exist. Labels
badge the count and worst status; borders go green/red on aggregate. This is
the owner's "labels on nodes with what needs to be tested".

## 5. Later (with the merge-back step)

The pipeline's runner report → `lastResult` writer onto the plan graph
(pass/fail paint after every run), and auto-generated assertion
implementations for the ui.* kinds in the generated step vocabulary.

## Sources

- Oracle strategies for MBT (state invariants as oracles): albany.edu/faculty/offutt (testOracle.pdf) · researchgate 305793864
- Oracle problem survey: academia.edu 24870121 · researchgate 318374513
- Assertion placement/frequency trade-off (GUI event sequences): the same MBT oracle literature; masking of corrupted states
- In-house corpus: `ui_only_assertions__sufficient__false`, `dual_layer_assertion__ui_plus_soql`, `sf_waits__condition_playbook`, STUDY-TEST-GRAPH-REPRESENTATION.md
