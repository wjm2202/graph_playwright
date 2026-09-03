# REVIEW — the whole process, walked; and the AI-scaffold pre-step

> **Status (2026-09-03): the pre-step it argues for exists.** The gap engine (`sfpw grillme`, `--json` for the array), the ADO importer and the script form are the hand-off from an AI draft to a human finish; `skills/graph-author/SKILL.md` is the AI-facing contract. The env-var commands named below (`GRILLME=`, `ADO_FILE=`, …) are now `sfpw` subcommands.

2026-08-31 · review only, no code changed. Question under review: *can we add a
pre-step where AI creates the scaffold and the human finishes it off?*
Verdict up front: **yes, and most of the machinery already exists.** The
engine (graph → journey → run → repaint) is built; what's missing is an input
adapter (ADO test plans in) and an interrogation step (/grillme) that turns a
vague plan into a complete scaffold. The human's remaining job collapses to the only
two things software can't do: demonstrate the clicks once, and exercise
judgment on what "correct" means.

---

## 1. The walk, station by station (notes as taken)

| # | Station | Who does it today | Labour | In → Out |
|---|---------|------------------|--------|----------|
| 1 | **Model the process** — planner UI: nodes, roles, systems, URLs, expects | Human, from their head | 20–40 min | nothing → `*.graph.json` |
| 2 | **Provision personas** — org users, `.env` creds | Human (org admin) | one-off ~10 min/role | `SETUP-REAL-ORG.md` → `.env` |
| 3 | **Capture** — dbl-click session node, paste `RECORD_PERSONA=… npm run record`, drive the flow, close window | Human demonstrates | 3–8 min/segment | clicks → `trace.zip` + `network.har` + manifest |
| 4 | **Distill + generate** | Automated (`npm run pipeline`) | 0 | traces → journey JSON + step impls + baselines + parameterized fills |
| 5 | **Bind step names** — `does` edge `data.catalog` must match generated names | Human agrees names by hand | 2–5 min, error-prone | naming friction |
| 6 | **Emit spec** — ▶ test ▾ / `graph:spec` | Automated | 0 | graph → `tests/e2e/<id>.journey.spec.ts` |
| 7 | **Run** — oracles, screenshots, timing grades, deny probes | Automated | 0 | run → report + evidence |
| 8 | **Merge-back** — plan repaints green/red, snapshots embed | Automated | 0 | report → painted graph |
| 9 | **Review + maintain** — read the painted graph; confirm dictionary heuristics; re-capture broken segments | Human judges | 5 min + drift | judgment |

Notes from the walk: stations 4, 6, 7, 8 are already zero-labour — the loop's
back half is done. **All remaining labour is in the front half (1, 3, 5) plus
one-off setup (2).** Station 1 is the largest recurring cost and is also the
one a language model is genuinely good at. Station 3 is the only *irreducibly*
human station — it is ground truth by demonstration. Station 5 shouldn't
exist at all (see elegance).

## 2. What can be automated

**Station 1 → the pre-step itself (biggest win).** Everything on a graph node
except the demonstration is *describable*: roles, ordering, systems, hand-offs,
what-must-be-true. Describable things can be drafted by AI from a test plan
and corrected by a human — authoring becomes reviewing. This is the ADO +
/grillme proposal in §5.

**Station 5 → delete by convention.** Step names should derive mechanically
(`<graph_id>.<edge_id>` or slug of the edge label — "create a lead" →
`lead.create`). Generator emits that name, walker expects it, no human naming
agreement exists to get wrong.

**Station 2 → an env doctor, not automation.** Creds stay human (and our
safety rules agree), but the *diagnosis* automates: walk graph → actors →
personas → env names, print exactly what's missing. The record script already
does this per-persona (`⏸ cannot record yet — …`); lift it to per-graph, and
badge it in the planner.

**Station 3 → shrink, don't replace.** Three shrinkers, in order of safety:
(a) **capture queue** — planner emits the ordered list of segments still
needing capture as one chained command, instead of node-by-node copy/paste;
(b) **pre-navigation** — the record session logs in via Cast and lands on
`node.url` before handing over, so the human demonstrates only the 3–4
meaningful clicks, never login/nav; (c) **AI-drafted capture** (experiment
tier) — for idiomatic Salesforce steps (New → fill by label → Save) an agent
drives a *sandbox* org using the data factory's safe identities and the human
watches/corrects rather than drives. (c) is real labour reduction but touches
a live org — sandbox-only, dry-run default, same containment the sweeper uses.

**Station 9 → triage drafts.** On failure we already hold the oracle result,
screenshot, and step context; add the nearest-a11y-match when a selector
misses and AI can draft "failed because toast said X / button renamed to Y —
proposed fix" instead of the human spelunking traces.

## 3. What can be made more elegant

**One verb.** Today the human must know the pipeline order. Invert it: a
single `npm run process <graph>` that *knows the state* — env missing? print
the doctor's list. Captures missing? print the queue. Everything present?
emit + run + repaint. The tool holds the checklist, the human only ever sees
"the one next thing".

**Planner as readiness cockpit.** Per-node badges: persona ✓ · captured ✓ ·
steps ✓ · last run ✓/✗. One glance = what's left. All four facts are already
computable; none is currently shown.

**Runlist over clipboard.** Save-time, planner writes `<graph>.runlist.json`
(ordered capture segments + personas); the record script consumes it. The
clipboard idiom stays for one-offs.

**Naming by convention** (station 5 above) — the contract disappears into the
generator.

## 4. What data to collect to lower human labour

Already collected: traces (selectors, timings), HAR (API shapes), settle
contracts, p95 baselines, per-step screenshots, oracle outcomes, deny
evidence, fill values + identity/business classifications. The harvest we're
*not* yet doing — each item feeds the pre-step:

| Collect | From | Buys |
|---|---|---|
| **Org atlas** — object names, field labels, buttons, list views, per persona | every capture + a one-time metadata crawl (REST `describe`) | scaffolds drafted with *real* labels; planner autocomplete; grillme asks specific, not generic, questions |
| **Required-field sets + picklist values per object** | validation errors and options seen in captures; `describe` | `seed()` creates setup records via API — setup steps stop needing capture at all |
| **Navigation map** — URLs per persona | trace page events | auto-fill `node.url`; deep-link inference |
| **Role capability matrix** | deny probes already prove can't-do; accumulate | auto-draft `denied` edges — the security tests humans forget to ask for |
| **Failure taxonomy** | oracle fails + screenshots + DOM at failure → substrate atoms | AI triage drafts; recurring-cause detection |
| **Labour telemetry** — wall-clock scaffold→green per process | timestamps we already emit | proves/refutes the 50% target with numbers (R9 G3 planned this) |

The org atlas belongs in the substrate (atoms per object/label, edges to the
domain hub) so it compounds across sessions and graphs.

## 5. Feeding ADO in, then /grillme

**The shape:** `ado:import` → *draft* scaffold graph → `/grillme` interrogation
→ *complete* scaffold → human captures → green. Two new pieces; the rest is
the existing engine.

**Getting plans out of ADO** — three tiers, start cheap:
1. **Paste/CSV** (day one): export test cases from an ADO query; zero
   integration, proves the mapping.
2. **REST** (when mapping is proven): Test Plans API — suites → test cases →
   the `Microsoft.VSTS.TCM.Steps` field (XML of action/expectedResult pairs),
   PAT auth from `.env` (`ADO_ORG`, `ADO_PROJECT`, `ADO_PAT`). Verify current
   API version at build time.
3. **Round-trip** (later): write run outcomes back as ADO test results —
   painted graph and ADO dashboard agree.

**The mapping (draft-quality by design):**

| ADO | Graph |
|---|---|
| Test case title | graph id + title |
| "As a / logged in as" phrases, area/tags | actors + session nodes |
| Step *action* column | `does` edges, grouped into session segments by role mentions |
| Step *expectedResult* column | `expects[]` — ui.toast/ui.text guesses; "record created/exists" → `api.record_exists` |
| Cross-system mentions (Siebel, integration) | handoff edges + checkpoint-at-end pattern (the lead_to_customer shape) |
| Attachments/links | node notes |

**/grillme** — a repo skill. It loads the draft, computes the gap list
mechanically (unmapped roles, missing URLs, oracle-less nodes, ambiguous data
fields, undeclared single-session systems, absent deny coverage), and asks
**pointed multiple-choice questions, one at a time**, cheapest-to-answer
first. The question taxonomy, from what humans actually get wrong:

1. *Role binding* — "'approver' in the plan: which persona? [lead_approver / credit_approver / new]"
2. *Oracle choice* — "what proves step 3 worked: toast text / field value on the record / row exists in Siebel?"
3. *Oracle placement* — "is that true after *create*, or only after *approve*?" (the `after=` decision)
4. *Data identity* — "'Email' on this form: unique per run (identity) or meaningful business value?"
5. *Session constraints* — "Siebel: one concurrent session? (we'll logout-to-comply)"
6. *Deny coverage* — "should the lead creator be *unable* to approve? Capability matrix says they lack the permset — add the deny edge?"
7. *Find-or-create* — "existing customer: reuse if present (`findBy`) or always create?"

Each answer writes directly into the scaffold. Output: a valid graph, every
`does` edge status `plan`, capture queue attached — the human's remaining
work is *only* station 3. Grillme answers are worth keeping as substrate
atoms (they're org facts: role bindings, session policies) so the *next*
grillme asks fewer questions. That is the compounding loop: every process
scaffolded makes the following one cheaper.

## 6. The thesis, and the labour math

Split every station's content into **describable** (structure, roles,
oracles, data classes — AI drafts, human approves), **demonstrable** (the
clicks — human, once, shrunk by pre-nav and queueing), and **judgment**
(is this the right oracle? — human, made cheap by multiple-choice).

Estimated per 5-role process, org already provisioned:

| | today | with pre-step |
|---|---|---|
| model/author | 20–40 min | grillme 5–10 min |
| captures | 20–40 min | 15–25 min (pre-nav + queue) |
| naming/binding | 2–5 min | 0 (convention) |
| review | 5 min | 5 min |
| **total** | **~50–90 min** | **~25–40 min** |

That clears the 50%-less-labour target, and the org atlas + answer-memory
make it improve with use rather than plateau.

## 6b. Assessment (added after review discussion)

**Is this an advance in testing?** In architecture yes, in proven outcomes not
yet. The ingredients are old (MBT/GraphWalker, record-replay, commercial flow
tools — mabl, Testim, ACCELQ, Provar). The uncommon synthesis: the graph is
**one living artifact** — plan, test source, run report, and evidence viewer
in a single object that repaints itself; plus declared multi-actor session
choreography, `denied` edges as first-class negative coverage, and data
uniqueness by construction killing replay rot. Caveats owned: never yet run
against a real org; the 50%-labour claim is unmeasured until the telemetry
item ships.

**Does it help someone build a complex E2E test?** Yes, at the exact pain
points: 5-role/2-system choreography becomes five `login as` edges; the
handoff+checkpoint-at-end pattern declares the integration check; `after=`
solves oracle placement; per-step evidence lets non-authors triage. Serves
the process-knower rather than the Playwright-knower — fully true once
grillme exists.

**One capture → graph for simple tests?** Mostly today, fully with a small
extension. `fromDistillation` already turns one recording into a process map
(actors, steps, timings, record handoffs) and `upgradeGraph` lifts it to v2.
Missing: collapsing step-per-node chains into the compact session → does →
data shape, and **drafting oracles from observed signals** — toast seen →
`ui.toast`, landing URL → `ui.url`, HAR create call → `api.record_exists`
with the real object — emitted as flagged guesses (`confirm once` idiom).
Then simple flows go: record once → graph appears → confirm 2–3 checks →
runnable forever. Two on-ramps meeting in the middle: plan-first
(ADO → grillme → capture) for complex processes, capture-first
(record → derived graph → confirm) for simple ones. A single capture can
never see deny cases, other roles, or alternate paths — grillme follow-up
territory.

## 7. Risks, honestly

- **ADO plans are often stale or vague.** That's precisely why grillme exists
  — the import is deliberately draft-quality and says so; confidence flags on
  every guessed mapping, same idiom as the dictionary's `heuristic — confirm
  once` flags.
- **AI-drafted capture touches a real org.** Experiment tier only: sandbox
  org, dry-run default, factory identities (`@e2e.invalid`, `E2E-` tags) so
  the sweeper can always undo it. Never on by default.
- **Don't build the REST integration first.** One CSV round-trip proves or
  kills the mapping for near-zero cost.
- **Grillme must not become a form.** One question at a time, skippable,
  defaults visible, answers remembered — otherwise it's just station 1 with
  extra steps.
- **Async integrations vs the fixed oracle timeout.** SF→Siebel replication
  is asynchronous; `ORACLE_TIMEOUT` is a flat 10s. The lead_to_customer
  Siebel checkpoint will need polling/retry oracle semantics (per-expect
  `timeoutMs` + poll interval on `api.*` kinds) or it will flake on real
  integration lag.

## 8. Proposed build order (when approved — nothing started)

1. **Polling oracles** — per-expect `timeoutMs`/poll on `api.*` kinds; small,
   and the real-org Siebel checkpoint is wrong without it. Tests: fake
   ApiOracle that succeeds on the Nth poll.
2. **Capture-first v2** — collapse fromDistillation chains into compact
   session → does → data shape + draft flagged oracles from observed toasts /
   URLs / HAR creates. Tests: fixture distillation → expected v2 scaffold
   with `confirm` flags. (Simple-test on-ramp complete.)
3. `ado:import` from CSV/paste → draft graph + confidence flags. Tests: fixture CSV → expected scaffold.
4. `/grillme` skill: gap-list computation + question loop + graph writeback + substrate memory of answers. Tests: gap detection on seeded drafts.
5. Naming convention + env doctor + planner readiness badges (deletes station 5, shrinks 2).
6. Capture queue + pre-navigation (shrinks station 3).
7. Org atlas harvest (describe crawl + capture accumulation) → substrate.
8. Labour telemetry (proves the target).
9. Later: ADO REST + results write-back; AI-drafted capture experiment.
