# Roles → accounts → env vars

*Decision 2026-09-02 (owner). Implemented in `src/personas/schema.ts` (the
model + the env convention), `src/personas/wiring.ts` (the rules the planner
drives: role → id, roles → logins, renames, `.env` presence — S2.3 moved them
out of the dev server), `src/personas/registry.ts`, `src/personas/doctor.ts`,
the planner personas dialog and `tools/serve-planner.mjs` (I/O only now).
Tests: `tests/unit/personas.spec.ts`, `tests/unit/personas-wiring.spec.ts`,
`tests/unit/doctor.spec.ts`, `tests/unit/serve-planner.spec.ts`,
`tests/harness/planner-import-cases.spec.ts`.*

## The problem it solves

Test cases talk in **roles** — *Client Associate*, *Client Lead*, *Business
Development Manager*. The runner logs in with **accounts** — real users in a
sandbox, whose credentials live in `.env`. Before this change the two were
one thing: every persona in `personas.json` spelled its own four env names,
so five roles pasted from an ADO pre-req meant twenty new env vars, and
nothing said that two of those roles were the same sandbox login.

## The model — three layers, one file, one convention

```
graph.actors        alias  → persona id          (the graph's roles)
personas.json       persona → account            (who plays whom)
personas.json       account → env NAMES          (derived — nobody spells them)
.env                env NAME → value             (the only thing typed by hand)
```

```jsonc
// personas.json
"accounts": {
  "client_lead":  { "auth": "frontdoor" },                 // env SF_CLIENT_LEAD_*
  "sales_mgr":    { "auth": "frontdoor", "poolSize": 2 },  // SF_SALES_MGR_*, clones _W0/_W1
  "siebel_admin": { "system": "siebel", "auth": "ui", "tokenEnv": "" }   // SIEBEL_ADMIN_*, no token
},
"personas": {
  "client_lead": { "kind": "internal", "role": "Client Lead", "account": "client_lead" },
  "bdm":         { "kind": "internal", "role": "Business Development Manager", "account": "sales_mgr" },
  "business_admin": { "kind": "internal", "role": "Business Admin", "account": "sales_mgr" }
}
```

Rules:

- **A persona is a role.** It carries what the test case knows — `role`,
  `kind`, `site`, `profile` — and the `account` it logs in as. Several roles
  may share one account.
- **One role name → one persona id, everywhere.** `slugRole()`
  (`src/personas/wiring.ts`) is the repo's single slug and is the alias
  `fromAdo` mints: a role pasted into the planner and the same phrase read out
  of an ADO pre-req become the same persona (lower_snake_case, 40 chars).
- **An account is a login in one application.** It owns `auth`, `poolSize`
  and, implicitly, the credentials. `system` defaults to `salesforce`.
- **Env names are derived, never spelled:**
  `<PREFIX>_<ACCOUNT>_USERNAME / _PASSWORD / _TOKEN / _TOTP_SECRET`, prefix
  `SF` for Salesforce, the system id upper-cased otherwise, and not repeated
  when the account id already starts with it (`siebel_admin` on siebel →
  `SIEBEL_ADMIN_*`). Pools suffix `_W<n>`. Token and TOTP are optional in
  `.env`; an override of `""` on the account says the login does not use one.
- **A typo is an error, never a new login.** `account` must name a declared
  account; the validator (and the dev server before every write) refuses
  otherwise.
- **Account ids are environment-neutral** — `sales_mgr`, not `sit_sales_mgr`.
  Switching SIT → UAT is a different `.env`, nothing else.
- **Legacy personas still validate.** A persona with `usernameEnv` and no
  `account` is its own login (a "self-wired" persona). Do not write new ones.
- **Secrets never enter `personas.json`** — unchanged: names only, the
  smell test rejects pasted values, the server never reads `.env` values
  beyond set/unset booleans.

## What each tool does with it

| Where | Behaviour |
|---|---|
| Planner **add ▾ → personas…** | Paste roles → a *logs in as* row per new role: *new login named after the role* (default), *same login as* another pasted role, or an *existing login*. On apply: personas + accounts written (validated, atomic), one `.env` block per **new login** shown to copy, the same names appended to `.env.example`. |
| Session card | A `login` line names the account and who else plays it; the credential names shown are the account's. Renaming a name edits the **account** (every role on it follows). |
| `npm run doctor` | `role ✗ lead → client_lead (login: sales_mgr)` per role, then `login ✗ sales_mgr plays client_lead, bdm — set …` per account: three roles on one unset login is one fix. |
| Cast / storageState | `.auth/<account>.json` — roles sharing a login share a cached session. |
| `grillme` `role_unbound` | Options are persona ids as before; the roster row shows `→ login <account>`. |

## Salesforce, today

The five roles the current Salesforce test cases name each have their own login:
`client_associate`, `client_lead`, `bdm`, `billing_collections`,
`business_admin`. Re-point a role at a shared account by editing its
`account` field — nothing else changes.

## Why not…

- *One env var per account with `user:pass` inside?* Mixes two secrets in
  one value, breaks token-only logins, and every secret scanner keys on
  `_PASSWORD`.
- *Accounts implied by the persona id, no `accounts` section?* Then a
  misspelled `account` silently becomes a new login with empty creds — the
  failure mode this design exists to remove.
- *Keep env names on the persona?* That is the state this replaces: N roles
  × 4 names, and no way to say two roles are one user.
