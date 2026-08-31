<!--
Thanks for sending this back — that's the whole point of the license.
CONTRIBUTING.md has the long version; this is the short one.
-->

## What this changes

<!-- One or two sentences. If it fixes an issue, "Fixes #123". -->

## Why

<!-- The problem, not the patch. What went wrong, or what couldn't be done before? -->

## How it was tested

<!-- Name the tests you added and what they'd catch if someone broke this later. -->

---

- [ ] **Tests ship with it** — `tests/unit/` for pure logic, `tests/harness/`
      for anything touching a browser, `tests/e2e/` (env-gated) for real-org
      flows. No exceptions.
- [ ] **The three gates are green locally:**
      `npm run typecheck` · `npm run lint` · `npm test`
- [ ] **No secrets.** `personas.json` carries env-var *names* only; `.env`,
      `.auth/` and `recordings/` stay gitignored.
- [ ] **Any `!` in `src/` has a comment** naming the invariant that makes it safe.
- [ ] **Planner rebuilt** if `tools/planner-src.html` changed
      (`npm run build:planner`, commit the regenerated file).
- [ ] **Commits are signed off** (`git commit -s` — DCO).

<!--
Not every box applies to every PR. An unchecked box with a sentence saying
why is a fine answer; a silently unchecked one just means a slower review.
-->
