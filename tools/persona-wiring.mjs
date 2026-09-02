/**
 * personas.json → what the planner page and the dev server tell the browser
 * about roles, accounts and credential env-var NAMES (never values). The
 * derivation itself lives in src/personas/schema.ts (transpiled into
 * tools/.planner-build/personas/schema.js by build-planner) — this file only
 * shapes it for the page. See docs/DESIGN-ROLES-ACCOUNTS.md.
 */

/**
 * { personaId → wiring }: roles (persona ids),
 * the ACCOUNT each logs in as, and that account's credential env-var NAMES
 * (derived by src/personas/schema.ts — names only, NEVER values). The check
 * panel knows who exists; the session card shows where each credential
 * comes from in .env.
 */
export function personaWiring(doc, personasLib) {
  const wiring = {};
  const orgUrlEnv = doc.org?.instanceUrlEnv ?? '';
  const siteUrlEnvs = {};
  for (const [k, s] of Object.entries(doc.sites ?? {})) siteUrlEnvs[k] = s.urlEnv;
  for (const id of Object.keys(doc.personas ?? {})) {
    const p = personasLib.effectivePersona(doc, id) ?? doc.personas[id];
    const account = personasLib.accountIdOf(doc, id);
    wiring[id] = {
      ...(p.usernameEnv ? { username: p.usernameEnv } : {}),
      ...(p.passwordEnv ? { password: p.passwordEnv } : {}),
      ...(p.tokenEnv ? { token: p.tokenEnv } : {}),
      ...(p.totpEnv ? { totp: p.totpEnv } : {}),
      ...(p.site && siteUrlEnvs[p.site] ? { url: siteUrlEnvs[p.site] } : { url: orgUrlEnv }),
      ...(p.kind ? { kind: p.kind } : {}),
      // How Cast acquires this persona's session — the check panel
      // compares it against what a login_as edge declares.
      ...(p.auth ? { auth: p.auth } : {}),
      ...(p.role ? { role: p.role } : {}),
      ...(p.kind !== 'guest' ? { account } : {}),
    };
  }
  return wiring;
}
/** Declared accounts (logins) with the roles each plays — for the personas dialog. */
export function accountList(doc, personasLib) {
  return Object.entries(doc.accounts ?? {}).map(([id, a]) => ({
    id, system: a.system ?? 'salesforce', auth: a.auth ?? '', roles: personasLib.rolesOfAccount(doc, id),
  }));
}
