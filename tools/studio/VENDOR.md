# Journey Studio — vendored copy

This folder is a verbatim copy of [journey-studio](https://github.com/wjm2202/journey-studio)
(MIT, same author) so this repo is standalone: nothing to clone or install
beyond `npm install` here. Zero runtime dependencies; needs `node >= 18` and,
for video work, `ffmpeg`/`ffprobe` on PATH (`brew install ffmpeg`).

| | |
|---|---|
| Upstream commit | `8683e48` + the `--no-open` flag, `lib/stitch.mjs` (multi-persona cut) and `lib/serve.mjs` (the HTTP surface as a mountable handler; pages use relative URLs) and `ingest --include-failed` (failed runs get a page with a FAILED banner), all landed upstream the same day |
| Copied | `bin/ lib/ web/ assets/ test/ drop LICENSE README.md` |
| Not copied | `playwright/narrated-step.ts` (optional rich-guide producer; this repo has its own producer in `tests/e2e/graphs.spec.ts`), `.github/`, sample `guides/` and `inbox/` |
| Tests | `npm run test:studio` → `node --test tools/studio/test/*.test.mjs` (the upstream suite, unchanged) |

How this repo uses it (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md):

- The planner (`npm run planner`) **mounts** it at http://127.0.0.1:8765/studio/ — same origin, no second process: `tools/serve-planner.mjs` imports `createStudioHandler` from `lib/serve.mjs`.
- The planner's Run button runs a graph, ingests `test-results/` here, and opens `/studio/studio.html?batch=…&slug=…` in a new tab.
- `npm run studio` serves the same `studio/guides` standalone on :8777 (optional); `npm run studio:ingest -- --batch <id>` ingests by hand.

To take a newer upstream: copy the same folders over this one, keep this file, run
`npm run test:studio` and `npm test` (the `studio-vendor` guard checks the shape).
