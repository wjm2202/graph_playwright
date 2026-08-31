# Contributing

Improvements are the point of this project's license and its ethos: if it
made your Salesforce testing better and you made *it* better, send the
change back. Personal and professional use are equally welcome.

## Ground rules

1. **Everything ships with tests.** No exceptions — it's how this repo got
   to 300+ tests with no org required. Pure logic → `tests/unit/`; anything
   touching a browser → `tests/harness/` (runs against local SLDS-shaped
   markup, no Salesforce needed); real-org flows → `tests/e2e/` (env-gated,
   must skip cleanly without `.env`).
2. **The three gates must be green** before a PR:
   ```bash
   npm run typecheck   # full Microsoft 5.9 strictness baseline
   npm run lint        # typescript-eslint strict-type-checked
   npm test            # unit + harness
   ```
   CI runs the same three on every PR — nothing else to configure.
3. **Never commit secrets.** `personas.json` carries env-var *names* only
   (the validator rejects pasted secrets, TOTP seeds included). `.env`,
   `.auth/`, and `recordings/` are gitignored — keep them that way.
4. **`!` needs a comment** in `src/` naming the invariant that makes it
   safe. In tests, `!` is fine.
5. The planner is built from `tools/planner-src.html` — edit that, run
   `npm run build:planner`, and commit the regenerated single-file output.
   `src/journeys/generated/` is pipeline output: regenerate, never hand-edit.

## Sign-off (DCO)

We use the [Developer Certificate of Origin](https://developercertificate.org/).
Add `-s` to your commits (`git commit -s`) to certify you have the right to
contribute the change under this project's license.

## Where to start

- `journeys/graphs/` + the planner (`npm run planner`) show the whole idea
  in two minutes.
- The **check panel** and `src/graph/gaps.ts` list what any graph still
  needs — the same engine powers good first issues.
- `docs/` holds the design studies behind every subsystem; `HANDOVER.md` is
  the honest build ledger, decisions and mistakes included.
- Growing the distiller grammar (`src/pipeline/distill.ts`) and the
  challenge-screen selectors (`src/auth/totp-challenge.ts`) are
  high-value, well-tested areas that thrive on real-world variety.

## Reporting problems

Open an issue with the failing command, the output, and (for org-dependent
problems) the `npm run doctor` report — it names exactly what's wired
without leaking any values.
