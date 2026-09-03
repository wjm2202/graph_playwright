---
name: graph-author
description: Create and complete process graphs for the graph_playwright repo — import Azure DevOps test cases into a project, turn them into draft graphs, then interrogate each graph one multiple-choice question at a time until only captures remain. Use when the user says "import test cases", "make graphs from ADO", "grill me", "fill the gaps", "complete this graph", "review these graphs", or hands you a .graph.json to check. The graph rules live in docs/GRAPH-SPEC.md; this skill tells you when to read it and which command to run at each step.
---

# graph-author — from test cases to complete, runnable graphs

You are helping a human turn business test cases into **process graphs**
(`projects/<project>/graphs/<id>.graph.json`) that the repo can run as
multi-actor Playwright tests. The AI drafts everything **describable**; the
human supplies **judgment** — one multiple-choice answer at a time. Nothing
you write bypasses the repo's validator.

**Read `docs/GRAPH-SPEC.md` before touching a graph.** It is normative and
drift-tested against the code: node/edge types, expectation kinds, data
ports, the login-chain rule, every gap kind and its write-back op, the
authoring checklist. Quote it rather than guessing.

Repo root: the `salesforce_playwright` folder. Run every command from it.
Playwright-based CLIs print their result on stdout; parse the marked lines
(`GAPS_JSON …`) rather than the prose.

## The three doors in — pick by what the human has

| They have | Door | Command / action |
|---|---|---|
| An ADO export (.xlsx / .csv) | **import cases** | Planner (`npm run planner` → **import cases** button): choose/create the project, upload, tick cases → graphs in `projects/<p>/graphs/`, file kept in `projects/<p>/imports/`. Or CLI: `ADO_FILE=<file> npm run ado:import` (writes to `journeys/graphs/`). |
| A process in their head | **planner** | `npm run planner`, draw sessions → does → data; or write the JSON from the spec's §11 example. |
| A test case as prose, or nothing but a description | **write the script** | Write the SCRIPT form (`docs/GRAPH-SPEC.md` §13) and compile it with `parseScript()` from `src/graph/script.ts` — no schema knowledge needed. |
| A recording | **capture-first** | `PIPELINE_GRAPH=1 npm run pipeline` |

### The script form — prefer it over hand-written JSON

When you are drafting a graph yourself, write §13's script and compile it,
rather than emitting `process-graph/2` JSON by hand. One session per `as`
line, one step per indented line, checks under the step they belong to:

```
create_customer  Create a customer

as client_associate at /lightning/o/Account/list
  create Customer record (Account) -> produces
    ✓ api.record_exists Account within 10000ms
    ? ui.toast was created
  must not delete Customer record

as billing_collections
  verify Customer record -> consumes
```

`parseScript(text)` returns `{ graph, problems }` — it never throws, every
complaint carries a 1-based line number, and the graph it returns always
passes `validateGraph`. `printScript(graph)` is the inverse and returns
`{ text, dropped }`: `dropped` names what the script form cannot carry
(positions, capture state, timing, infra nodes, notes), so **never round-trip
a captured graph through the script to edit it** — you would drop the
evidence. Use the script to CREATE; use the planner or the gap ops to edit.

Rules that still apply: leave a port off when you do not know it (`inferPorts`
drafts it later — do not guess `-> produces` to look complete), mark every
guessed check with `?`, and never invent a persona for the `(persona)` slot.

After any door, every graph is a DRAFT: machine guesses are `draft: true`
(checks), `ioDraft: true` (ports), or `role_unbound` (personas). Your job is
to clear them with the human.

## The loop — one graph at a time

1. **List graphs**: `projects/*/graphs/*.graph.json` (ref = `<project>/<id>`)
   and legacy `journeys/graphs/*.graph.json` (ref = `<id>`). If the human did
   not name one, ask which.
2. **List gaps**: `GRILLME=<ref> npm run grillme`. Parse the `GAPS_JSON`
   line — an array of `{kind, at, question, short, options?}`. Also read the
   `[chain]` lines: a MUST FIX chain error (branch/cycle/disconnected start)
   comes before any question — fix the wiring first.
3. **Ask in this order** (cheapest judgment first), ONE question per beat,
   using the gap's own `question` and `options` (always allow a free-text
   answer). Up to 4 questions of the SAME kind may share one turn.
   1. `role_unbound` — bind to a persona id from `personas.json` (the options
      carry the roster). **Never invent a persona id.** When the roster
      lacks the role, propose adding it the way the planner does
      (`docs/DESIGN-ROLES-ACCOUNTS.md`): a persona
      `{ kind: internal, role: "<as the test case says>", account: <id> }`
      plus, if the login is new, `accounts.<id>: { auth: frontdoor }`.
      Ask which LOGIN the role plays as — a new one named after the role,
      or an existing account (several roles may share one). Env names are
      derived from the account id (`SF_<ACCOUNT>_USERNAME/_PASSWORD`,
      optional `_TOKEN`/`_TOTP_SECRET`) — never spell them, never write
      values; add the block to `.env.example` and tell the human to fill
      `.env`.
   1b. A pre-req like *"Personas who can perform this action: A, B, C, D"*
      names the ROLES IN THE PROCESS. Default reading (owner, 2026-09-02):
      the role names say what each one does — map them to a chain of
      hand-overs, one session per persona, using the reference graph
      `journeys/graphs/lead_to_customer.graph.json` (creator → approver →
      credit check → customer approver) and business logic: who creates the
      lead, who advances it to a prospect, who requests the credit check,
      who decides it, who converts to customer. Only when the human says
      the list means "any ONE of these" use the persona matrix instead
      (one session + `alternatives`, spec §3.3). When unsure, propose the
      chain and ask.
   2. `no_session_policy` — one session max (logout-to-comply) vs concurrent.
   3. `draft_oracle` — keep / edit / remove each guessed check.
   4. `data_io_draft` — keep the guessed port (produces/consumes/updates)?
   5. `data_no_port` — does this step create, read, or update the record?
   6. `data_unproduced` — created earlier (wire a `produces` edge before it),
      seeded (`origin: seed`), or pre-existing (`origin: external`)?
   7. `api_no_timeout` — synchronous (default) or async budget
      (2 min → `timeoutMs 120000, pollMs 5000`; 5 min → `300000/5000`).
   8. `no_oracles` — what proves the state: toast → `ui.toast`, text →
      `ui.text`, record exists → `api.record_exists`, field → `api.field_equals`.
   9. `no_deny_coverage` — name a must-NOT action, or accept none.
   10. `session_no_url` — landing URL per session (free text is fine).
   11. `does_unbound` — accept the `<noun>.<verb>` suggestion or rename.
   Skip `not_captured` — that is the human's recording work, not a question.
4. **Write back**: translate the answers into a JSON array of ops (see the
   spec §9 table: `bindRole`, `setCatalog`, `confirmExpect`, `removeExpect`,
   `setOracleBudget`, `setUrl`, `addDeny`, `setSessionPolicy`, `setIo`,
   `confirmIo`, `setOrigin`), save it as a file, then
   `GRILLME=<ref> GRILLME_APPLY=<ops.json> npm run grillme`. It validates
   before saving and prints the change list — relay it. For `no_oracles` and
   `data_unproduced`→"wire a produces edge", edit the graph JSON directly
   (an `expects` entry / an edge with `data.io: "produces"`), keeping it
   valid per the spec, then re-run step 2.
5. **Repeat** from step 2 until only `not_captured` remains.
6. **Close**: print the capture queue — for each uncaptured session
   `RECORD_PERSONA=<persona> RECORD_JOURNEY=<graph_id> npm run record` — plus
   `GRAPH_DOCTOR=<ref> npm run doctor` (env readiness) and
   `SUITE=graph:<ref> npm run suite` (run it — one generic spec walks every
   graph a suite selects; add the graph to `suites.json` or give it a `tags`
   entry to make it part of a standing suite).
   Tell the human: captures are the only remaining human work.

## Reviewing a graph someone else made

Run the spec's §12 checklist against the file: validator ok, one linear
login chain reaching every session, every role bound, every `does` bound or
queued, every edge onto a `data` node carries a port and every consume has
a definition before it, every data/checkpoint node has a confirmed check,
async backend checks carry budgets, non-SF systems declare a session policy,
multi-role graphs carry a `denied` edge. Report by section; propose ops, do
not silently rewrite.

## Presentation (the human reads the canvas)

Short labels: nodes `Account record`, `Sales Support Case`; edges a verb
phrase plus the ADO step range, `convert lead → new account (ADO 2–4)`. Long
detail goes in `notes`. Give every node a `pos`: sessions as a staircase
left→right, records in a column on the right, `end` top-right — dagre alone
turns two sessions × four records into a hairball.

## Hard rules

- Never invent a persona id, a system key, or an SObject name — ask.
- Never delete or overwrite a graph; every write goes through the apply
  CLI (which validates) or is a minimal JSON edit you re-validate by running
  step 2 again.
- One question per beat. "skip" leaves the gap on the list; report skipped
  gaps at the end.
- Draft checks or ports the human rejects are removed, not silently kept.
- Secrets never enter a graph: a graph names ROLES only; env-var NAMES
  (`SF_ADMIN_USERNAME`) belong to accounts in `personas.json`; values live
  only in `.env`; never URLs with credentials.
- If a command fails, show the error verbatim and stop; do not work around
  the validator.

## Where things are

- Spec: `docs/GRAPH-SPEC.md` · design history: `docs/DESIGN-PROCESS-GRAPH.md`,
  `docs/STUDY-TEST-GRAPH-REPRESENTATION.md`, `docs/DESIGN-EXPECTATIONS.md`,
  `docs/STUDY-DATA-FLOW.md`
- Engine: `src/graph/gaps.ts` (questions + ops), `src/graph/schema.ts`
  (validator), `src/graph/compose.ts` (chain + dataflow referees)
- Roster: `personas.json` · projects: `projects/<p>/project.json`
- Imports: `projects/<p>/imports/*.json` manifests say which case became
  which graph — use them to trace a graph back to its ADO row.
