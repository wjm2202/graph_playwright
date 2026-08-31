# ATOM-SCHEMA — salesforce-mcp substrate encoding

Written 2026-08-30 (session 2), after the encoding shipped. Documents what is IN the
substrate, the conventions used, and the maintenance rules. Source batches:
`L2/encoding/batch-01..10.json`, validated by `L2/encoding/validate.mjs` (run:
`node L2/encoding/validate.mjs` — exit 0 = publishable).

## Shipped inventory (verified against server responses)

| Batch | Content | Atoms | treeVersion |
|---|---|---|---|
| 01 | Domain + 11 hubs + five-pillars + task atom | 14 | 22 |
| 02 | Platform glossary (§2.1) | 18 | 23 |
| 03 | Platform internals: shadow DOM, LWS, network (§3, §14) | 17 | 24 |
| 04 | Auth & session patterns (§4, §8.2) | 16 | 25 |
| 05 | Locator + wait strategy (§5, §6) | 13 | 26 |
| 06 | Component recipes + flake control (§7, §10) | 14 | 27 |
| 07 | Experience Cloud portals (§2.2, §8) | 17 | 28 |
| 08 | Architecture/data/CI + ecosystem (§9, §11) | 25 | 29 |
| 09 | 20 anti-patterns (§12) | 20 | 30 |
| 10 | Volatile dated states (§13) | 9 | 31 |

**Totals: 163 atoms, 508 edges (358 declared + auto produced_by provenance), edges/atoms 2.21 declared.**
110 facts, 31 procedures, 9 states, 11 hubs, 1 domain, 1 task. Zero rejections, zero
legacy fact names. Known variance: 2 declared edges deduped by server (batches 02, 07) —
immaterial, graph audited via retrieval spot-checks.

## Hub set (all `v1.other.*`, single-underscore `hub_` style)

Resident-seed convention (`hub_corrections`, `hub_decisions`, `hub_substrate_*`) was
followed — NOT the global mmpm `hub__` double-underscore style. Reused resident hubs
where semantics fit (decision atoms are dual-hubbed into `hub_decisions`).

`hub_sf_platform` · `hub_sf_auth` · `hub_sf_locators` · `hub_sf_waits` ·
`hub_sf_components` · `hub_sf_portals` · `hub_sf_architecture` · `hub_sf_antipatterns` ·
`hub_sf_ecosystem` · `hub_sf_volatile` · `hub_sf_journeys` (pre-minted, empty until step 3)

Root: `v1.domain.salesforce_testing`. Every hub is `member_of` the domain. Task:
`v1.task.sf_playwright_l2__build` — pass as `taskContext` on every project checkpoint.

## Naming conventions (v2 triple grammar)

- **3 segments** `subject__predicate__value` = conflict-gated claim. Used for every
  bannable/binary position: `xpath__pierces_shadow_dom__false`,
  `data_testid__standard_ui_available__false`, `per_test_ui_login__use__banned`,
  `test_pyramid__e2e_scope__journeys_only`. A future opposite claim COLLIDES by design.
- **2 segments** `subject__predicate` = payload-carrying facet, never conflicts:
  `frontdoor_jsp__mechanics`, `sf_locators__stability_ranking`.
- **Confidence markers** survive as payload prefixes: `[V-O]` official docs, `[V-M]`
  2+ independent sources, `[S]` single practitioner source, `[INF]` grounded inference.
- **Ordered procedures** (auth hierarchy, four-suspects diagnostic, stability ranking)
  are single numbered-step payloads (all fit ≤4096 chars) — the ordering IS the content;
  edge-chaining was rejected as it fragments retrieval.
- **Volatiles** are `v1.state.*` with `_dt_YYYY_MM_DD` suffix; every payload names its
  OBSOLETED WHEN condition. On change: mint successor + `supersedes` edge + tombstone
  the old one in the same checkpoint. Never edit a dated state atom in place.
- **Journeys (step 3, reserved):** `v1.procedure.journey_<id>__definition` (payload =
  compact journey JSON), `v1.fact.journey_<id>__coverage` (roles/objects),
  `v1.procedure.step_<catalog_id>__contract` — all `member_of` → `hub_sf_journeys`.

## Edge usage

member_of 169 · references 133 · constrains 26 (anti-patterns → the procedures they
limit; volatile states → the procedures they gate) · derived_from 24 (findings →
evidence) · depends_on 6 (prerequisite ordering). Every atom hub-edged in its own batch;
cross-batch edges only target earlier batches or resident seeds.

## Retrieval verification (2026-08-30, treeVersion 31)

| Query | Rank-1 hit |
|---|---|
| "does xpath work with shadow dom on lightning" | `xpath__pierces_shadow_dom__false` ✓ |
| "how to log in programmatically as a portal persona" | task atom, then `multi_persona_auth__project_shape` + `hub_sf_portals` ✓ |
| "test is flaky asserting a success toast" | `ui_only_assertions__sufficient__false` + dual-layer + toast-timing ✓ |

All results Merkle-verified; conflict keys registered on 3-segment facts.

## Recorder telemetry (CDP) — storage split (decided 2026-08-30, treeVersion 33)

CDP-harvested telemetry splits by **variance**, not by journey:

| Harvested thing | Store | Why |
|---|---|---|
| Settle signatures (click → /aura burst → settle signal) | `v1.procedure.step_<catalog_id>__settle_contract` atoms, keyed to the STEP-CATALOG capability | Same capability settles the same way in every journey — reusable; journeys `references`-edge their contracts. URL families + methods only, never request counts/sequences (release churn). networkidle is banned output. |
| Numeric baselines (mean/p95 per step) | `baselines.json` in-repo ONLY | Updates every green run — rolling measurements don't belong in an append-only Merkle log. |
| Payload parameterization rules (volatile id → `{ref:}`) | `v1.procedure.distiller__parameterization_rules` | Durable distiller knowledge; automates `record_ids__hardcoding__banned`. Ids/shapes only, never full bodies. |
| Recorder constraints | `v1.fact.cdp_recorder__browser_support__chromium_only` | Capture is Chromium-only; playback stays plain Playwright. Use `Accessibility.queryAXTree` per node, not `getFullAXTree` (LEX tree too large). |

Rule of thumb: **atoms hold what a future session must KNOW; files hold what the
runner must COMPUTE.** Changes-every-run → file; changes-only-on-release/design → atom.

## Maintenance rules

1. Each seasonal release (Spring ~Feb, Summer ~Jun, Winter ~Oct): re-verify every
   `hub_sf_volatile` state atom; supersede+tombstone changed ones.
2. New knowledge goes through a batch file + `validate.mjs` BEFORE `session_checkpoint`
   — the validator is the pre-publish test and stays in the repo.
3. Corrections from the user: `v1.procedure.*` + `constrains` edge + `member_of` →
   resident `hub_corrections`, then train in a SEPARATE follow-up checkpoint.
4. `nonV2FactNames` must be empty on every checkpoint response; read back
   `atomsAdded`/`edgesAdded` and investigate any shortfall beyond edge dedupe.
