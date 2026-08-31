# SPRINT S-REC — Recorder Pipeline: record → distill → generate → run

*Drafted 2026-08-30 (session 2 end). Substrate: salesforce-mcp, treeVersion 33.
Implements every directed feature not yet built: design doc §7 (human-driven
codegen), the CDP telemetry decisions (`cdp_telemetry__storage_split__*`), and
real-org first contact. Prior work this builds on is DONE and green: personas,
Cast, seed, journey schema/catalog/runner, baselines grading, e2e smoke.*

## Goal (the 50% mechanism)

A human drives a persona-authenticated headed browser through a flow ONCE. The
system emits: journey JSON (schema-valid, parameterized), step-catalog stubs for
anything unrecognized, settle-contract atoms (batch file, validator-clean), and
baselines.json timing. The second journey is mostly recognized vocabulary; the
tenth is entirely vocabulary. Denials stay authored (recording can't demonstrate
absence) but get capture assistance.

**Non-goals this sprint:** Option C account broker (deferred until scale demands
it) · CDP v2 injected/raw-session recorder (stretch S1 only) · cross-browser
capture (playback stays plain Playwright; capture is Chromium-only by decision).

## Standing rules (every item)

- Tests for everything; suite + typecheck + `npm run validate:encoding` green
  before an item closes (G0). New generated-code tests must assert the output
  NEVER contains `networkidle` (banned: `networkidle__valid_on_lex__false`).
- Substrate writes go through batch files + validate.mjs + orchestrator review —
  the pipeline never checkpoints atoms directly.
- Git commits are human-only. `git init` before R1 lands (H0).

## Human-only prerequisites (H0 — gates R8, not R0–R7)

1. On the Mac: `npm install` in `salesforce_playwright/`, then `git init` + first
   commit. (Why: deps exist only in the sandbox; git protects the sprint. Safe:
   local only.)
2. SETUP-REAL-ORG.md end-to-end: sandbox users (MFA waiver, not API-only,
   pinned locale, trusted IPs), `.env` filled, smoke green:
   `npm run test:e2e -- tests/e2e/multi-persona-smoke.spec.ts`
3. Pick journey #1 to record (the reference expense flow, or any real flow in
   your org — the step-catalog vocabulary grows from whatever you record first).
4. Optional: raise/reset the API spend limit if agent delegation is wanted
   (resets 6pm Pacific/Auckland daily).

## Work items

**R0 — baselines.json lifecycle.** `src/journeys/baselines.ts`: load/save,
rolling-window update on green runs (n, meanMs, p95Ms per `idx:actor/step` key),
`--update-baselines` flag wiring in a small runner harness helper. The runner
already grades; this adds the write side. *Tests:* rolling math (p95 from a
window, window cap), merge semantics (new step, existing step, journey rename →
orphan pruning), file round-trip, updates ONLY on fully-green reports.

**R1 — record script (v1, trace-based).** `scripts/record.ts` + npm script:
`npm run record -- --persona sales_user --journey expense_v2 [--expect-denial]`.
Launches a HEADED Chromium context pre-authenticated via Cast (real auth
ladder), starts `context.tracing` (snapshots on) + HAR, human drives, Ctrl-C or
`--seconds` ends; writes `recordings/<journey>/<persona>-<ts>/{trace.zip,har,manifest.json}`.
Multi-actor = one run per persona, same `--journey`. *Tests:* CLI parsing,
manifest shape, output-path conventions, persona validation against
personas.json (unit); a sandbox-generated trace against a harness page proves
the recording plumbing headlessly (integration).

**R2 — trace reader.** `src/pipeline/traceReader.ts`: Playwright trace.zip +
HAR → neutral `RawEvent[]` (action events with locator info + timestamps,
navigation, network request/response summaries scoped to `/aura`, `/sfsites/aura`,
`/services/data`). Trace format is Playwright-internal: pin the version in the
reader, fail loudly on unknown schema. *Tests:* a COMMITTED fixture trace
(generated in-repo by a script against harness pages, regenerable per Playwright
upgrade) parses to the expected event list; unknown-schema fixture fails with
the pinned-version message.

**R3 — distiller.** `src/pipeline/distill.ts`: starter action grammar —
`combobox.select` (combobox click → option click), `form.fill` (label fill →
`with` arg), `recordPage.open` (nav to /lightning/r/…), `modal.save` +
toast expect (Save click → toast), generic `click` fallback. Per step: settle
signal (the network burst / DOM condition the human actually waited on) +
duration. Unrecognized sequences → raw fallback steps FLAGGED for naming.
Payload parameterization per `distiller__parameterization_rules`: harvested ids
(15/18-char, keyprefix) reappearing later → `{ref:}`; human-typed values →
`with` args / `{unique:}`. *Tests:* each recognizer on synthetic RawEvent
sequences; burst-to-action attribution windows; id-correlation → ref rewriting;
duration accumulation feeding R0's shapes; flagging of unknowns.

**R4 — generator.** `src/pipeline/generate.ts`: DistilledStep[] →
(a) `journeys/<id>.json` that passes `validateJourney` against personas.json,
(b) step-catalog stub file `src/journeys/catalog.<domain>.stubs.ts` with
TODO-marked implementations + settle-wait code shaped by the contract (never
networkidle — asserted by test), (c) baselines entries via R0, (d) settle-contract
batch `L2/encoding/batch-rec-<id>.json` in the shipped format, validate.mjs-clean,
NOT auto-published. *Tests:* golden files end-to-end (fixture events → expected
four outputs, byte-stable), schema validity, validator exit 0, networkidle ban.

**R5 — deny capture assist.** `--expect-denial` mode: recording as the WRONG
persona captures refusal evidence (absent control vs error toast vs 4xx on the
attempted call) and emits the deny step + a probe stub (UI + API halves per
`deny_probes__semantics__ui_plus_api`). *Tests:* synthetic refusal recordings →
deny step + stub emission; a non-refusal recording in this mode FAILS the
generation ("expected a denial, captured success").

**R6 — multi-actor stitch.** `src/pipeline/stitch.ts`: merge per-persona
recordings for one journey id on the timeline, correlating shared record ids
from harvested payloads (the expense the submitter created is the one the
approver touched → same `{ref:}`). *Tests:* two synthetic sessions → one
interleaved step list, correct actor attribution, cross-actor ref unification,
clock-skew tolerance.

**R7 — pipeline CLI + integration proof.** `npm run pipeline -- --journey <id>`
(reader → distill → stitch → generate), README section. *Integration test (the
G1 gate):* fixture recording → generated journey executed by the REAL runner
against a harness catalog → green, zero hand edits to the JSON.

**R8 — real-org binding (pair session, needs H0).** Record journey #1 on the
sandbox, generate, implement the emitted stubs against the real objects, run
`test:e2e` until green; capture baselines from 3+ green runs. Produces the first
real settle-contract batch.

**R9 — substrate sync + close-out.** Orchestrator reviews and publishes the
settle-contract batch (validate → checkpoint → read-back counts → retrieval
spot-check), session event + phase-state supersede/tombstone
(`sf_playwright_project__phase__*`), HANDOVER.md update, G3 measurement stored.

**S1 (stretch) — CDP v2 capture.** Raw CDP session alongside the human:
`Accessibility.queryAXTree` per interacted node (never getFullAXTree on LEX),
`Network.getResponseBody` scoped to `/aura` + `/services/data` (ids/shapes only,
no full bodies), out-of-band, zero injected JS. Same RawEvent model — the
distiller doesn't change, only signal quality does.

## Pre-registered gates (no tuning after measurement)

- **G0** every item: suite green (≥101 passing), typecheck 0, validator 0.
- **G1** (R7): fixture recording → runnable journey through the real runner,
  zero hand edits to journey JSON (stub implementations excluded).
- **G2** (R8): a real recorded org flow generates a journey that goes green on
  the org with ≤2 hand edits to the JSON; second run attaches sessions ~100ms.
- **G3** (R9): journey #2 creation time (record + review + stub work) measured
  at ≥50% below the hand-authoring estimate for the same flow; numbers stored
  as facts, not vibes.

## Sequencing & sessions

R0 ∥ R1 → R2 → R3 → R4 → {R5 ∥ R6} → R7 → R8 (needs H0) → R9.
Suggested sessions: **S-A** R0–R2 · **S-B** R3–R4 · **S-C** R5–R7 (G1) ·
**S-D** R8–R9 with you driving the browser (G2, G3). Delegate drafting
(recognizers, fixtures, golden files) to sub-agents when the spend limit
allows; orchestrator reviews every diff and owns all substrate writes.

## Risks → mitigations (all already encoded as atoms)

Trace format is internal → version-pinned reader + committed fixtures (R2).
Aura network churn → URL families only; contracts superseded per release
(`step_settle_contract__atom_pattern`). networkidle temptation → banned by
generator test. Chromium-only capture → accepted decision. Token expiry
mid-recording → Cast re-auth ladder + delete `.auth/*.json`. Baselines churn →
files not atoms (`cdp_telemetry__storage_split__*`). Sandbox browser quirks →
`cowork_sandbox__browser_test_recipe` (never shipped).
