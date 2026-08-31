# L2 — the knowledge cache

This directory is the project's L2 cache: durable, evaluated knowledge that survives across sessions, orgs, and test projects. Code implements it; sessions bootstrap from it.

## Contents

- **FOUNDING-DOCUMENT.md** — the research corpus (2026-08-30). Salesforce Lightning + Experience Cloud testing with Playwright/TypeScript: application language, platform internals, verified patterns, pitfalls, architecture. Every claim carries a confidence marker ([V-O]/[V-M]/[S]/[INF]) and a source.

## How to use it

- **Starting work**: read FOUNDING-DOCUMENT.md §1 (five pillars) and the section matching your task. §13 lists volatile facts — re-verify those each Salesforce release before trusting them.
- **Hitting a wall**: §8.3 (portal "sees nothing" diagnostic), §10 (flake root-cause table), §12 (anti-pattern list) are the lookup tables.
- **Learning something new**: corrections and hard-won findings go here first (and into the memory substrate once it exists), then into code.

## Planned

- `ATOM-DESIGN.md` — step 2: the atom schema mapping this corpus into the MMPM substrate (fact/procedure/state typing, naming grammar, hub + edge design). Section 15 of the founding doc holds the pre-work observations.
- Encoded atom exports / substrate sync notes.
