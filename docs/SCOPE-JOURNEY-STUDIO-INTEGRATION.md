# Scope: run a graph in the planner, review it in Journey Studio

Status: M1 + M2 + M3 shipped 2026-09-06 (see §7); Journey Studio vendored AND mounted in the planner at /studio/. §8 is tomorrow's checklist — the harness runs and the first real org run need the owner's Mac.
Decisions taken by the owner while scoping: planner button triggers the run; failed runs must be reviewable too. Revised the same day: Journey Studio is vendored (`tools/studio`) and MOUNTED in the planner at `/studio/` — one process, one origin, the review is a link and a button.

## 1. Goal and verdict

Press **Run** on a graph (or suite) in the planner. When it finishes, the planner shows **review in Journey Studio ↗**; clicking it opens a new tab at Journey Studio's studio page for that exact test — video, trace-mined steps, API calls, console, flag-a-step notes.

Verdict: feasible with **no new dependencies** and a thin seam. Journey Studio already consumes exactly one input — a Playwright JSON report folder with videos and traces — and already has a deep link per test (`studio.html?batch=…&slug=…`). The work is (a) make this repo *produce* that input, (b) give the planner server a run→ingest→link route, and (c) two small changes inside Journey Studio (review failures, don't auto-open a browser). Estimated 4–5 days including tests, split into milestones below so each is shippable alone.

## 2. What exists today, and the gaps

| Journey Studio needs | This repo today | Gap |
|---|---|---|
| Playwright `json` reporter → `results.json` | `reporter: [['list'], ['html']]` (`playwright.config.ts:21`) | add `['json', {outputFile:'test-results/results.json'}]` |
| `video: 'on'` (guide needs a `video` attachment) | video unset = off (`playwright.config.ts:23-26`) | turn on for the `e2e` project only |
| `trace: 'on'` (steps are mined from the trace when a test has no `test.step`) | `trace: 'on-first-retry'` | `'on'` for `e2e` when not CI |
| a stable per-test slug | test title **is** the graph ref (`tests/e2e/graphs.spec.ts:58`); slug would be `slugify(title)` truncated to 60 chars | add a `{type:'guide'}` annotation with an explicit `objective` so the slug is ours, not derived |
| something to trigger ingest after a run | planner "Run this graph" only **copies** `npx sfpw suite graph:<ref>` to the clipboard (`tools/planner-v2/js/strip.js:39,61-64`) | new `POST /__run` on the planner server, modelled on `/__record` (`tools/serve-planner.mjs:533-560`) |
| a link target | none — the planner never links to any Playwright report | `JOURNEY_STUDIO_URL` + slug + batch id |
| a page for failed tests | Journey Studio builds guides only from **passing** tests (`lib/build-core.mjs:71-74`); failures are dashboard cards with error text only | opt-in `includeFailed` in Journey Studio |

Facts that make this easy: `runGraphFile` already writes `test-results/<test>/run/report.json` (`src/graph/run.ts:83-86`), which can be attached to the test for a future graph panel; the planner server already has the spawn/poll/tail pattern (`startRecording`, `serve-planner.mjs:436-467`); Journey Studio's ingest **copies** video/trace into its own `guides/<batch>/<slug>/` (`lib/ingest.mjs:158-162`), so `test-results/` being wiped on the next Playwright run does not break old links.

## 3. Design

```
planner.html ──POST /__run {ref|suite}──▶ serve-planner.mjs
                                            │ spawn: npx sfpw suite graph:<ref>      (SUITE env, video+trace+json on)
                                            │        └─ writes test-results/results.json + video.webm + trace.zip
                                            │ spawn: journey-studio ingest --from test-results --batch <runId>
                                            │                          --out <studio out> --no-serve --include-failed
                                            │ read:  <studio out>/index.json  → batch entry → guides[{slug,title,outcome}]
                                            ▼
             GET /__run/<id> ──▶ {status, tail, studio:{dashboard, tests:[{ref, slug, outcome, url}]}}
planner shows  "review in Journey Studio ↗"  →  http://127.0.0.1:8777/studio.html?batch=<runId>&slug=<slug>
                                                  (Journey Studio `serve --dir <studio out>` runs separately)
```

### 3.1 Produce the input (this repo)

`playwright.config.ts`, `e2e` project only:

```ts
use: { baseURL: …, video: process.env.CI ? 'off' : 'on', trace: process.env.CI ? 'on-first-retry' : 'on' }
```

and top-level `reporter: [['list'], ['html', {open:'never'}], ['json', {outputFile: 'test-results/results.json'}]]`. The json reporter is cheap and applies to every project; video/trace stay scoped to `e2e` so `npm test` (unit+harness) is unchanged.

`tests/e2e/graphs.spec.ts`, inside the test body: push one annotation and one attachment.

```ts
testInfo.annotations.push(guideAnnotation(ref, variant, graph));   // {type:'guide', description: JSON}
…
await testInfo.attach('graph-run', { path: join(runDir, 'report.json'), contentType: 'application/json' });
```

`guideAnnotation` and `guideSlug` live in a new **pure** module `src/studio/slug.ts`:
`guideSlug('salesforce/o2a_tc01', 'default') → 'salesforce--o2a_tc01'`, variants → `'salesforce--o2a_tc01--as-partner'`. Rules: `[a-z0-9_-]` only, ≤ 60 chars, variant always in the slug (Journey Studio **throws** on duplicate explicit slugs, `lib/build-core.mjs:82-83`, and the persona matrix would otherwise collide). The annotation's `journeyRef` carries the ref verbatim so the planner can map slug → graph without re-deriving anything; `category` = project name.

Why an explicit slug rather than letting Journey Studio derive one: the planner needs to build the link *before* it reads Journey Studio's output, and derived slugs get auto-numbered on collision (`-2`, `-3`), which would make links guessable only after the fact.

### 3.2 Run + ingest + link (planner server)

New routes in `tools/serve-planner.mjs`, same shape as the record routes:

| Route | Body / query | Behaviour |
|---|---|---|
| `POST /__run` | `{ref}` or `{suite}` | 409 if a run is in flight (Playwright wipes `test-results/` at start — runs must serialise). Spawns `PLANNER_RUN_CMD` (default `npx sfpw suite <spec>`) with `cwd: root`. On exit spawns `PLANNER_INGEST_CMD` (default `<journey-studio bin> ingest --from test-results --batch <id> --out <out> --no-serve --include-failed`). Returns `{ok,id,pid,batch}`. |
| `GET /__run/<id>` | — | `{ok,id,status:'running'\|'ingesting'\|'done'\|'failed', exitCode?, tail[40], studio?}`. `studio` is filled by reading `<out>/index.json` and picking the batch entry (`ingestFolder` returns `{id, results, tests[{title,outcome,slug?}], guides[]}`, `lib/ingest.mjs:218-230`) — each `tests[]` row becomes `{ref: title, outcome, slug, url}`. |
| `GET /__runs` | — | last N runs from `<dataRoot>/studio/runs.json` (gitignored) so links survive a planner reload. |
| ~~`GET /__studio`~~ | — | retired the same day — with the studio mounted there is nothing to probe. |
| `/studio/…` | — | **shipped 2026-09-06 (replaces the separate process):** the vendored Journey Studio is MOUNTED in the planner — `tools/studio/lib/serve.mjs` exports its whole HTTP surface as a handler and the planner delegates `/studio/*` to it. Same origin, one process, one port; `/__studio`, `/__studio/start`, `JOURNEY_STUDIO_URL` and autostart are gone. |

**Open the review (shipped 2026-09-06):** the `open review` toggle (`f_openreview`, remembered, on by default) makes the Run click open a tab immediately — inside the user gesture, which is what popup blockers permit — showing *running…*; when the run finishes the page points that tab at the review (`/studio/studio.html?batch=…&slug=…` for one reviewable test, else the batch dashboard). Every pill is also a plain same-origin link, and *open review ↗* repeats the same target.

Config (all env, documented in `.env.example`): `JOURNEY_STUDIO_URL` (default `http://127.0.0.1:8777`), `JOURNEY_STUDIO_OUT` (default `<dataRoot>/studio/guides`), `JOURNEY_STUDIO_BIN` (default `npx journey-studio`). `SERVER_CAPABILITIES` (`serve-planner.mjs:72`) gains `runs: true, studio: true` and bumps `version` to 8 so the UI feature-detects.

Batch id: `run-<YYYYMMDD-HHMMSS>-<spec slug>` (e.g. `run-20260906-143012-graph-salesforce--o2a_tc01`). Journey Studio's HTTP routes sanitise batch ids to `[A-Za-z0-9._-]` (`bin/journey-studio.mjs:190,209`); the CLI `--batch` takes the id verbatim, so the planner must emit only that charset, and this shape does.

Dependency — **vendored, decided 2026-09-06**: Journey Studio is copied into `tools/studio/` (`bin/ lib/ web/ assets/ test/`, MIT licence, `VENDOR.md` records the upstream commit) so this repo is standalone — nothing to clone, no second project, no network fetch beyond `npm install`. It has zero runtime dependencies, so a copy costs nothing (`tests/unit/studio-vendor.spec.ts` guards that and the shape). Scripts: `studio` (serve `studio/guides` on 8777, `--no-open`), `studio:ingest` (last `test-results/` → `studio/guides/<batch>`), `test:studio` (the upstream suite, 87 tests, runs here). `.gitignore` ignores `/studio/` (root only — `tools/studio/` is tracked).

### 3.3 Planner UI

`strip.js`'s **Run this graph** becomes a real run (`P2.net.startRun(ref)`, poll like `startRecording`, `net.js:253-292`); the copy-command stays as a secondary "copy CLI" affordance so CI users lose nothing. While running: the tail in the strip. When done: one pill per test (green/red by outcome) with **review in Journey Studio ↗** (`target=_blank`, `rel=noopener`) → `studio.html?batch=&slug=`, plus a run-level **dashboard ↗** → `dashboard.html?batch=`. The suite run box (`library.js:191-197`) gets the same treatment. Last run per graph is shown on the library row from `/__runs`.

`docs/PLANNER-FEATURE-PARITY.md` is normative and guarded by `tests/unit/planner-parity.spec.ts` — every new control and route must be added there or the suite goes red.

### 3.4 Journey Studio changes (separate repo, zero-dep, `node --test`)

1. **Review failures.** `buildFromReport(report, {includeFailed})`: when set, a test whose final attempt is not `passed` but has a `video` attachment still yields a guide, with `outcome: 'failed'|'flaky'|'skipped'` and `error` (scrubbed, ≤ 200 chars — reuse `outcomesFromReport`'s existing scrub) on the bundle and registry entry. `ingest --include-failed` and `POST /api/ingest?includeFailed=1` pass it through. Dashboard card shows the outcome pill it already has; `studio.html` gets a red banner with the error above the timeline. Nothing changes for callers that do not pass the flag.
2. **`serve --no-open`.** `serve()` always opens a browser (`bin/journey-studio.mjs:300-305`); the planner-launched case wants it quiet.
3. Optional, later: pass unknown attachments (our `graph-run`) through to `guide.json.attachments[]` so a graph panel can render per-node pass/fail next to the video.

Note: the journey-studio working tree currently has uncommitted edits (`web/dashboard.html`, `web/studio.html`, new `lib/journey-note.mjs`). Commit those first so the `file:` dependency and the `github:#sha` pin are both meaningful.

### 3.5 Multi-persona video: one stitched cut (shipped 2026-09-06)

Facts, from source: Playwright names each page's recording `<recordVideo.dir>/<page guid>.webm` (`playwright-core/lib/coreBundle.js:36791-36792`) — nothing overwrites; frames are stamped with wall-clock time; `page.video().path()` is known at page creation. Playwright's bundled ffmpeg is built `--disable-everything` with only `pad/crop/scale` filters and vp8 (`ffmpeg -buildconf`), so it cannot compose — stitching needs a system ffmpeg, which Journey Studio already requires for `splice`.

Contract: the `cast` fixture attaches one `video` per recorded page (primary actor first) and `graphs.spec.ts` attaches `video-timeline` = `{ videos: [{id, persona, file, startedAt}], segments: [{persona, startedAt, endedAt, title, status}] }` (`src/studio/video.ts buildVideoTimeline`; `StepReport.startedAt` added in `src/journeys/runner.ts`). Journey Studio's `lib/stitch.mjs` turns that into ONE `raw.webm` that follows the acting persona: each step shows that persona's screen; the gap before a step shows the next actor being brought on (their login); a persona with no footage yet holds the previous source; nothing is read past a recording's real end. `guide.json.stitched` records the recordings and clips. Proven with real ffmpeg on colour clips (`test/stitch.test.mjs`): the output is the right colour at every phase.

## 4. Link contract (the only thing both sides must agree on)

`<JOURNEY_STUDIO_URL>/studio.html?batch=<batchId>&slug=<guideSlug(ref, variantId)>` and `<JOURNEY_STUDIO_URL>/dashboard.html?batch=<batchId>`.
Both params are read verbatim by `web/studio.html:192-193` and `web/dashboard.html:232-234`. Nothing else in Journey Studio needs to know about graphs, projects or Salesforce.

## 5. Known unknowns — settle these in M0 before building on them

1. **Multi-persona videos — RESOLVED by code review (2026-09-06), not the spike.** Playwright injects `recordVideo` only inside its own `context` fixture factory (`playwright/lib/index.js:377-384`); a hand-made `browser.newContext()` gets viewport/locale/storageState merged in (`:128-131, :266-330`) but never `recordVideo`. Cast opens every persona that way and `graphs.spec.ts` never touches the `page`/`context` fixtures, so `use: { video: 'on' }` alone would have recorded **nothing** and Journey Studio would have skipped every test. Tracing is different: it hooks every context through client instrumentation and merges all chunks into one `trace.zip` (`workerProcessEntry.js:683-685`), so the trace side was already fine. Fix shipped in M1: Cast records itself — `src/studio/video.ts` (pure policy mirroring Playwright's on/retain-on-failure/on-first-retry, plus `collectVideos`), `Cast.contextOptionsFor(persona)` adds `recordVideo: { dir: <test output>/videos/<persona> }`, the ladder's three `newContext` calls use it, and the `cast` fixture attaches every `.webm` as `video` (primary actor first — the one Journey Studio picks) plus a `videos` manifest `[{persona, file}]`. Guarded by `tests/unit/studio-config-guardrail.spec.ts` and proven with a real browser in `tests/harness/cast-video.spec.ts`. Follow-up for Journey Studio: read all `video` attachments + the `videos` manifest and offer per-persona tabs.
2. **Trace-mined steps on Lightning.** Journey Studio's chapters come from trace actions when there are no `test.step`s. Salesforce Lightning is chatty; the spike shows whether the mined chapters are readable or whether M4 (one `test.step` per graph node) should be pulled forward.
3. **Run time and disk.** Video + `trace:'on'` on a 300 s graph walk: measure the overhead and the size of one ingested batch. Retention is manual (Journey Studio soft-removes into `_to_delete/`), so a `studio/` growing by ~50–200 MB per run needs at least a note in the README.

## 6. Tests (one per change, per the house rule)

This repo (Playwright `unit`/`harness` projects):

- `tests/unit/studio-slug.spec.ts` — `guideSlug` is pure: charset, ≤ 60, variant included, distinct for distinct (ref, variant), round-trips through `guideAnnotation` → `JSON.parse`.
- `tests/unit/studio-config-guardrail.spec.ts` — reads `playwright.config.ts` and asserts the json reporter is present, and video/trace are set on `e2e` only (same pattern as the existing isolation/parity guardrails).
- `tests/unit/serve-planner.spec.ts` (extend) — `POST /__run` 409 while in flight; `PLANNER_RUN_CMD` pointed at a stub script that writes a fixture `test-results/results.json`; `PLANNER_INGEST_CMD` pointed at a stub that writes a fixture `index.json`; `GET /__run/<id>` reaches `done` with the expected `url`; `GET /__studio` reports `up:false` when nothing listens.
- `tests/harness/planner-run-review.spec.ts` — real planner server on a tmp root (recipe already used by `tests/harness/planner-projects.spec.ts`), click Run, wait for the pill, assert the anchor's `href` equals the contract in §4 and `target=_blank`.
- `tests/unit/planner-parity.spec.ts` — goes red until `PLANNER-FEATURE-PARITY.md` lists the new controls/routes; that is the intended guard.

Journey Studio (`node --test`):

- `test/build-core.test.mjs` — `includeFailed` off: unchanged; on: failed+video → guide with `outcome`+`error`, failed without video → still skipped, passed → `outcome:'passed'`.
- `test/ingest.test.mjs` (extend) — batch entry `tests[]` rows for failed guides carry `slug`.
- `test/serve-ingest.test.mjs` (extend) — `?includeFailed=1` honoured; `--no-open` does not spawn `open`.

## 7. Milestones

| # | Deliverable | Effort | Status (2026-09-06) |
|---|---|---|---|
| M0 | Spike: one real graph run with video on, ingest by hand, open the studio page. | ½ day | **owner** — needs the org; §5.1 was settled by code review instead, see §3.5 |
| M1 | Config + annotation + attachment + `src/studio/slug.ts` + guardrail tests. `npm run studio`. Per-persona video in Cast. | 1 day | **shipped** |
| M2 | Journey Studio: `--no-open`, stitching (§3.5), `includeFailed` (`ingest --include-failed`: a failing run gets a page with a FAILED banner + error; the planner always passes it). | ½–1 day | **shipped** |
| M3 | Planner `/__run`, `/__runs`, `/__studio`, UI pills + links, parity doc, harness test. Journey Studio vendored into `tools/studio/`. | 1½–2 days | **shipped** — `tests/unit/serve-planner.spec.ts` (4 new, real vendored ingest), `tests/harness/planner-run-review.spec.ts` (browser, owner runs) |
| M4 | `test.step` per graph node (runner hook) + `graph-run` panel in the studio. | 1–2 days | later |

## 8. Tomorrow's check — the whole path, in order (why / where / safe)

Everything below runs in `Documents/code/SalesForce/salesforce_playwright`. Nothing touches git. Steps 1–3 need no org; step 4 is the first one that logs into your sandbox.

1. `npm install` then `npm test` — why: 611 unit tests + the harness with a real browser, including `tests/harness/cast-video.spec.ts` (per-persona video actually records) and `tests/harness/planner-run-review.spec.ts` (Run click → tab → `/studio/…`), which could not run in the sandbox. Safe: local browser only.
2. `npm run test:studio` — why: the vendored Journey Studio's 92 tests, incl. the real-ffmpeg stitch proof; needs `ffmpeg`/`ffprobe` on PATH (`brew install ffmpeg`) or the two ffmpeg tests skip. Safe: tmp dirs only.
3. `npm run planner`, open http://127.0.0.1:8765/, open a complete graph (strip says *complete — only recording is left*). Check http://127.0.0.1:8765/studio/ answers (empty dashboard). Why: proves the mount before any run.
4. Press **Run this graph** with *open review* ticked. A tab opens at once saying *running…*; the strip shows *running… → ingesting…*; when done the tab lands on `/studio/studio.html?batch=run-…&slug=<project>--<id>--default` and the strip shows one pill per test (green/red, both clickable) + *dashboard ↗* + *open review ↗*. Where: your sandbox org, the same `node bin/sfpw.mjs suite graph:<ref>` a terminal would run. Safe: writes `test-results/` and `studio/` (both gitignored).
5. In the studio tab: the video plays and scrubs (Range), the step list is trace-mined, a failed run shows the red *FAILED — <error>* banner above the video. Multi-persona graphs: the video is ONE cut following the acting persona (`guide.json.stitched` lists the clips); without ffmpeg it falls back to the first persona's recording.
6. No org configured (`hasOrgConfig()` false): tests skip → grey *○ skipped — no page* pills and the tab lands on the batch dashboard. That is expected, not a bug.

Known limits: one run at a time (409 — they share `test-results/`); the *running…* tab stays open for the length of the run (up to 300 s per test); `npx sfpw` is not linked into `node_modules/.bin` by `npm install` — the planner runs `node bin/sfpw.mjs` for that reason.
