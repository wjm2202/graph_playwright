/**
 * personas.json — types + dependency-free validation.
 *
 * Hard rule (founding doc §12 anti-pattern 10, substrate atom
 * credentials__hardcoding__banned): personas.json carries env-var NAMES only.
 * The validator REJECTS anything that smells like an inline secret so a
 * credential can never be committed via this file.
 */

export type PersonaKind = 'internal' | 'portal' | 'guest';
export type AuthMethod = 'frontdoor' | 'singleaccess' | 'ui';

/**
 * An ACCOUNT is a real login in one application (docs/DESIGN-ROLES-ACCOUNTS.md).
 * It owns the credentials; its env-var names are DERIVED from its id and
 * system — `<PREFIX>_<ACCOUNT>_USERNAME/_PASSWORD/_TOKEN/_TOTP_SECRET`
 * (`SF_` for salesforce) — so nobody spells them. The *Env fields exist only
 * to override the convention for a legacy .env vocabulary.
 */
export interface AccountDef {
  /** Application the login belongs to — `salesforce` (default), `siebel`, … */
  system?: string;
  auth?: AuthMethod;
  /** Clone logins available for parallel workers (…_USERNAME_W0…). */
  poolSize?: number;
  /** Convention overrides — env-var NAMES, never values. */
  usernameEnv?: string;
  passwordEnv?: string;
  tokenEnv?: string;
  totpEnv?: string;
}

export interface PersonaDef {
  kind: PersonaKind;
  /** Site key (required for portal, optional for guest). */
  site?: string;
  /** The ROLE as the test cases name it ("Client Lead"). */
  role?: string;
  profile?: string;
  license?: string;
  permissionSets?: string[];
  /**
   * Which declared account plays this role — REQUIRED for every internal /
   * portal persona (roles may share an account; guests have none). Sprint
   * 4.4 removed the legacy self-wired path: a persona never carries
   * credential env names of its own, the account owns the wiring.
   */
  account?: string;
  auth?: AuthMethod;
  /** Clone accounts available for parallel workers (SF_X_USERNAME_W0…). */
  poolSize?: number;
}

/**
 * A persona as the runtime sees it: the authored role fields plus the
 * credential env NAMES DERIVED from its account. Never authored — the four
 * *Env keys are rejected on a persona by the validator.
 */
export interface EffectivePersona extends PersonaDef {
  usernameEnv?: string;
  passwordEnv?: string;
  tokenEnv?: string;
  totpEnv?: string;
}

export interface PersonasDoc {
  org: { instanceUrlEnv: string };
  sites?: Record<string, { urlEnv: string }>;
  /** Logins, one block per application account; env names derived from the id. */
  accounts?: Record<string, AccountDef>;
  /** Roles (test-case vocabulary) → the account that plays each. */
  personas: Record<string, PersonaDef>;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const PERSONA_ID_RE = /^[a-z][a-z0-9_]*$/;
const KINDS: PersonaKind[] = ['internal', 'portal', 'guest'];
const AUTHS: AuthMethod[] = ['frontdoor', 'singleaccess', 'ui'];

/** Keys allowed on a persona — anything else is rejected (typo/secret guard). */
const ALLOWED_KEYS = new Set([
  'kind', 'site', 'role', 'profile', 'license', 'permissionSets', 'account', 'auth', 'poolSize',
]);
const ACCOUNT_KEYS = new Set(['system', 'auth', 'poolSize', 'usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv']);
/** Credential wiring lives on the ACCOUNT only (sprint 4.4). */
const CRED_ENV_KEYS = ['usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv'] as const;

/** Value shapes that indicate someone pasted a secret instead of an env name. */
function smellsLikeSecret(key: string, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (/^(password|token|secret|sid|accesstoken)$/i.test(key)) return true; // forbidden key names entirely
  if (!key.endsWith('Env')) return false;
  // *Env fields must be env-var NAMES, not values:
  if (!ENV_NAME_RE.test(value)) return true;
  if (value.length > 64) return true;
  // A long all-caps run with NO underscore reads like a pasted base32/hex
  // secret (TOTP seeds, tokens), not a name — real env names are worded:
  if (value.length >= 12 && !value.includes('_')) return true;
  return false;
}

export function validatePersonas(doc: unknown): ValidationResult {
  const errors: string[] = [];
  const d = doc as Partial<PersonasDoc> | null;

  if (!d || typeof d !== 'object') return { ok: false, errors: ['personas doc must be an object'] };

  if (!d.org || typeof d.org.instanceUrlEnv !== 'string' || !ENV_NAME_RE.test(d.org.instanceUrlEnv)) {
    errors.push('org.instanceUrlEnv must be an ENV VAR NAME (e.g. SF_INSTANCE_URL)');
  }

  const sites = d.sites ?? {};
  for (const [siteId, site] of Object.entries(sites)) {
    if (!site || typeof site.urlEnv !== 'string' || !ENV_NAME_RE.test(site.urlEnv)) {
      errors.push(`sites.${siteId}.urlEnv must be an ENV VAR NAME`);
    }
  }

  const accounts: Record<string, AccountDef> = d.accounts ?? {};
  if (d.accounts !== undefined && (typeof d.accounts !== 'object' || d.accounts === null || Array.isArray(d.accounts))) {
    errors.push('accounts must be an object keyed by account id');
  } else {
    for (const [id, a] of Object.entries(accounts)) {
      const at = `accounts.${id}`;
      if (!PERSONA_ID_RE.test(id)) errors.push(`${at}: id must be lower_snake_case (it becomes the env prefix ${id.toUpperCase()})`);
      if (!a || typeof a !== 'object') { errors.push(`${at}: must be an object`); continue; }
      for (const [k, v] of Object.entries(a as unknown as Record<string, unknown>)) {
        if (!ACCOUNT_KEYS.has(k)) errors.push(`${at}.${k}: unknown key (no inline credentials — the env names are derived from the account id)`);
        // An EMPTY override means "this login does not use it" (no token, no MFA) — allowed except for the username.
        if (v === '' && k.endsWith('Env')) { if (k === 'usernameEnv') errors.push(`${at}.usernameEnv: cannot be empty — every login has a username`); continue; }
        if (smellsLikeSecret(k, v)) errors.push(`${at}.${k}: looks like an inline secret/value — *Env overrides carry env-var NAMES only`);
      }
      if (a.system !== undefined && (typeof a.system !== 'string' || !PERSONA_ID_RE.test(a.system))) {
        errors.push(`${at}.system: must be a lower_snake_case application id (salesforce, siebel, …)`);
      }
      if (a.auth && !AUTHS.includes(a.auth)) errors.push(`${at}.auth: must be one of ${AUTHS.join('|')}`);
      if (a.poolSize !== undefined && (!Number.isInteger(a.poolSize) || a.poolSize < 1)) errors.push(`${at}.poolSize: must be an integer >= 1`);
    }
  }

  if (!d.personas || typeof d.personas !== 'object' || Object.keys(d.personas).length === 0) {
    errors.push('personas must be a non-empty object');
    return { ok: false, errors };
  }

  for (const [id, p] of Object.entries(d.personas)) {
    const at = `personas.${id}`;
    if (!PERSONA_ID_RE.test(id)) errors.push(`${at}: id must be lower_snake_case`);
    if (!p || typeof p !== 'object') { errors.push(`${at}: must be an object`); continue; }

    for (const [k, v] of Object.entries(p as unknown as Record<string, unknown>)) {
      if ((CRED_ENV_KEYS as readonly string[]).includes(k)) {
        errors.push(
          `${at}.${k}: credential env names live on the ACCOUNT, not the persona (sprint 4.4 removed self-wired personas). ` +
          `Fix: declare accounts["${id}"] = { "system": "salesforce" } (add ${k} there only to override the derived name), ` +
          `then set personas["${id}"].account = "${id}" and delete ${k} from the persona.`,
        );
      } else if (!ALLOWED_KEYS.has(k)) errors.push(`${at}.${k}: unknown key (no inline credentials — use *Env names)`);
      if (smellsLikeSecret(k, v)) errors.push(`${at}.${k}: looks like an inline secret/value — *Env fields carry env-var NAMES only`);
    }

    if (!KINDS.includes(p.kind)) errors.push(`${at}.kind: must be one of ${KINDS.join('|')}`);
    if (p.kind === 'portal' && !p.site) errors.push(`${at}: portal personas require a site`);
    if (p.site && !sites[p.site]) errors.push(`${at}.site: '${p.site}' not declared in sites`);

    const account = p.account !== undefined ? accounts[p.account] : undefined;
    if (p.account !== undefined && (typeof p.account !== 'string' || !account)) {
      errors.push(`${at}.account: '${p.account}' is not declared in accounts (declare it — a typo must never become a new login)`);
    }
    // What Cast will actually use — the account's method wins over the persona's.
    const auth = account?.auth ?? p.auth;

    if (p.kind === 'guest') {
      if (p.account !== undefined) errors.push(`${at}: guest personas are unauthenticated — no account`);
    } else {
      if (p.account === undefined) {
        errors.push(
          `${at}.account: required — every ${p.kind} persona names the declared account that plays it. ` +
          `Fix: add accounts["${id}"] = { "system": "salesforce" } to personas.json, then set personas["${id}"].account = "${id}" ` +
          `(env names are derived from the account id; run 'npx sfpw doctor' for the .env block).`,
        );
      }
      if (p.auth && !AUTHS.includes(p.auth)) errors.push(`${at}.auth: must be one of ${AUTHS.join('|')}`);
      if (p.kind === 'portal' && auth === 'frontdoor') {
        errors.push(`${at}.auth: portal personas use 'singleaccess' on the SITE domain (classic frontdoor is unreliable for community sessions — founding doc §4.2/§8.2)`);
      }
    }

    if (p.poolSize !== undefined && (!Number.isInteger(p.poolSize) || (p.poolSize) < 1)) {
      errors.push(`${at}.poolSize: must be an integer >= 1`);
    }
    if (p.permissionSets !== undefined && !Array.isArray(p.permissionSets)) {
      errors.push(`${at}.permissionSets: must be an array`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── accounts → env names (the convention, in one place) ──────────────────

/** Env-var prefix per application: salesforce → SF, anything else its own id upper-cased. */
export function envPrefixFor(system?: string): string {
  if (!system || system === 'salesforce') return 'SF';
  return system.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export interface CredEnvNames {
  username: string;
  password: string;
  token: string;
  totp: string;
}

/**
 * The four env names an account reads — derived
 * `<PREFIX>_<ACCOUNT>_USERNAME/_PASSWORD/_TOKEN/_TOTP_SECRET` (the prefix is
 * not repeated when the id already starts with it), unless the
 * account overrides one (legacy .env vocabulary). Token and TOTP are
 * optional in .env; their NAMES are still fixed so `.env.example` and the
 * doctor can print them.
 */
export function accountEnvNames(accountId: string, account: AccountDef = {}): CredEnvNames {
  const prefix = envPrefixFor(account.system);
  const id = accountId.toUpperCase();
  // `siebel_admin` on siebel reads SIEBEL_ADMIN_*, not SIEBEL_SIEBEL_ADMIN_*.
  const base = id.startsWith(`${prefix}_`) ? id : `${prefix}_${id}`;
  // An override of '' switches the credential OFF for this login.
  return {
    username: account.usernameEnv ?? `${base}_USERNAME`,
    password: account.passwordEnv ?? `${base}_PASSWORD`,
    token: account.tokenEnv ?? `${base}_TOKEN`,
    totp: account.totpEnv ?? `${base}_TOTP_SECRET`,
  };
}

/** The account id a persona logs in as. Guests have none — their own id stands in. */
export function accountIdOf(doc: PersonasDoc, personaId: string): string {
  return doc.personas[personaId]?.account ?? personaId;
}

/**
 * The persona as Cast sees it: kind/site/role from the persona, credentials
 * + auth + pool from its ACCOUNT (derived names filled in). Guests are
 * unauthenticated and come back unchanged; every other persona must name an
 * account (the validator refuses otherwise — sprint 4.4 removed the
 * self-wired path). Unknown ids → undefined.
 */
export function effectivePersona(doc: PersonasDoc, personaId: string): EffectivePersona | undefined {
  const p = doc.personas[personaId];
  if (!p) return undefined;
  if (p.kind === 'guest') return p;
  if (p.account === undefined) {
    throw new Error(
      `persona '${personaId}' names no account — every internal/portal persona must name one. ` +
      `Fix: declare accounts['${personaId}'] in personas.json and set personas['${personaId}'].account.`,
    );
  }
  const account = doc.accounts?.[p.account] ?? {};
  const names = accountEnvNames(p.account, account);
  const auth = account.auth ?? p.auth;
  const poolSize = account.poolSize ?? p.poolSize;
  return {
    ...p,
    usernameEnv: names.username,
    ...(names.password ? { passwordEnv: names.password } : {}),
    ...(names.token ? { tokenEnv: names.token } : {}),
    ...(names.totp ? { totpEnv: names.totp } : {}),
    ...(auth !== undefined ? { auth } : {}),
    ...(poolSize !== undefined ? { poolSize } : {}),
  };
}

/** Which roles (persona ids) an account plays — for the doctor and the planner. */
export function rolesOfAccount(doc: PersonasDoc, accountId: string): string[] {
  return Object.keys(doc.personas).filter((id) => accountIdOf(doc, id) === accountId && doc.personas[id]?.kind !== 'guest');
}

/**
 * The `.env` block for one account, ready to paste — the ONE thing a human
 * does by hand. Names only; the values are theirs to fill.
 */
export function envBlockFor(doc: PersonasDoc, accountId: string): string[] {
  const account = doc.accounts?.[accountId];
  if (!account) return [];
  const names = accountEnvNames(accountId, account);
  const roles = rolesOfAccount(doc, accountId).map((id) => doc.personas[id]?.role ?? id);
  const system = account?.system ?? 'salesforce';
  const lines = [`# ${accountId} — ${system} login${roles.length ? ` for: ${roles.join(', ')}` : ''}`];
  if (names.username) lines.push(`${names.username}=`);
  if (names.password) lines.push(`${names.password}=`);
  if (names.token || names.totp) lines.push('# optional: token (preferred over password when set), TOTP secret (only under MFA)');
  if (names.token) lines.push(`${names.token}=`);
  if (names.totp) lines.push(`${names.totp}=`);
  return lines;
}
