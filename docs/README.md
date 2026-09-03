# docs/ — what to read, and what it is

Three kinds of document live here. **Normative** ones describe the code as it
is and are drift-tested against it — if they disagree with the code, a test
fails. **Ledgers** record what was decided and shipped, newest last, and are
never rewritten. **Design history** is the reasoning that led to the current
shape; it is kept because the decisions in it still hold, but the mechanisms
it describes may since have been replaced, and each file says so at the top.

## Normative — read these to author or run a graph

| File | What it settles | Guarded by |
|---|---|---|
| [GRAPH-SPEC.md](GRAPH-SPEC.md) | The `process-graph/2` contract: node and edge types, validator rules, data-flow ports, the gap questions and their write-back ops, the script form, a complete minimal graph, the "done" checklist | `tests/unit/graph-spec.spec.ts` fails if the code gains a type, kind or op this page does not name |
| [DESIGN-ROLES-ACCOUNTS.md](DESIGN-ROLES-ACCOUNTS.md) | Role → persona → account → env-name convention; who may share a login; what `.env` holds and what it never holds | `tests/unit/personas.spec.ts`, `personas-wiring.spec.ts` |
| [PLANNER-FEATURE-PARITY.md](PLANNER-FEATURE-PARITY.md) | Every control, gesture, route and `window.planner` name of the planner, and what happened to each one of the retired planner's | `tests/unit/planner-parity.spec.ts` fails if the planner source has a control the table does not name |
| [../skills/graph-author/SKILL.md](../skills/graph-author/SKILL.md) | How an AI completes a graph without bypassing the validator: the doors in, the script grammar, `sfpw grillme --json` | `tests/unit/graph-spec.spec.ts` (its command list) |

## Ledgers — what was decided, in order

| File | Covers |
|---|---|
| [../HANDOVER.md](../HANDOVER.md) | Session-by-session: what shipped, what it changed for a user, release notes for anything that affects existing files |
| [SPRINT-PLAN-PLANNER-V2.md](SPRINT-PLAN-PLANNER-V2.md) | The four sprints that retired the first planner and the v1 graph form and shipped the Journey Script Planner, `sfpw` and suites — each sprint's deliverables, tests and outcome |
| [REVIEW-SIMPLIFICATION-2026-09-03.md](REVIEW-SIMPLIFICATION-2026-09-03.md) | The code-complexity review that produced that plan: what was accretion, what was essential, the measured cost of the old authoring flow, and the script-first design |
| [SPRINT-RECORDER-PIPELINE.md](SPRINT-RECORDER-PIPELINE.md) | The recorder sprint: record → distill → generate → run |

## Design history — why things are the shape they are

Read these for the reasoning; check GRAPH-SPEC for the current mechanism.

| File | Decided | Since replaced |
|---|---|---|
| [STUDY-TEST-GRAPH-REPRESENTATION.md](STUDY-TEST-GRAPH-REPRESENTATION.md) | Nodes are states, edges are relations (`process-graph/2`) | the v1 activity-node form it argues against is gone; the study's conclusion is the spec |
| [DESIGN-PROCESS-GRAPH.md](DESIGN-PROCESS-GRAPH.md) | The four planning data points (account, URL, steps, snapshot), merge-back, the planner as the plan/test/report surface | its v1 node types, the Mermaid/batch exporters and the first planner |
| [DESIGN-EXPECTATIONS.md](DESIGN-EXPECTATIONS.md) | Assertions live on nodes (`expects`), polled for backend kinds, drafts for machine guesses | — |
| [STUDY-DATA-FLOW.md](STUDY-DATA-FLOW.md) | Data flows on the edges: ports, reaching definitions, first-touch inference | the `ref`/`origin`/`bind` fields it proposed collapsed into the node id and `external` (§7 of the spec); its §5 is marked superseded |
| [DESIGN-PROJECTS.md](DESIGN-PROJECTS.md) | `projects/<name>/` as the unit of team ownership; refs as `<project>/<id>` | per-graph spec generation, replaced by suites |
| [multi-actor-orchestration-design.md](multi-actor-orchestration-design.md) | The Cast: one context per persona per system, session policies, denial probes | — |
| [REVIEW-AI-SCAFFOLD-PRESTEP.md](REVIEW-AI-SCAFFOLD-PRESTEP.md) | An AI drafts, a human finishes: the gap engine as the hand-off | the env-var CLIs it names are now `sfpw` subcommands |
| [PROTOTYPE-journey-script-planner.html](PROTOTYPE-journey-script-planner.html) | The owner-approved design study for the planner (open it in a browser) | it is a mock with demo data; the real planner is `tools/planner-v2/` |

`review-shots/` holds screenshots taken while reviewing the planner. They are
gitignored and regenerable: `node tools/review/drive-planner.mjs` against a
running `npm run planner`.
