/**
 * S2.3 — the persona wiring RULES, in one place (review §3.2: "business logic
 * living only in the dev server").
 *
 * Everything here is pure: a roster in, a roster out. The dev server
 * (tools/serve-planner.mjs, through the tools/.planner-build bridge), the
 * CLI and the skills all call these instead of re-deriving them — including
 * `slugRole`, which is THE role-name → id slug for the repo (it is
 * fromAdo's alias slug, so a role pasted into the planner lands on the same
 * persona id the ADO import would have made).
 *
 * Nothing in this file touches the filesystem, and nothing here reads a
 * credential VALUE: `.env` is only ever asked whether a name is set.
 */

import { parse as parseDotenv } from 'dotenv';
import {
  accountEnvNames, envBlockFor,
  type AccountDef, type PersonasDoc,
} from './schema';

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const PERSONA_ID_RE = /^[a-z][a-z0-9_]*$/;

/** The credential a name is wired to. `${slot}Env` is the key on disk. */
export type CredSlot = 'username' | 'password' | 'token' | 'totp';
export const CRED_SLOTS: CredSlot[] = ['username', 'password', 'token', 'totp'];

/** The four *Env keys — they live on an ACCOUNT and nowhere else. */
type CredHolder = Pick<AccountDef, 'usernameEnv' | 'passwordEnv' | 'tokenEnv' | 'totpEnv'>;
const ENV_KEY: Record<CredSlot, keyof CredHolder> = {
  username: 'usernameEnv', password: 'passwordEnv', token: 'tokenEnv', totp: 'totpEnv',
};

/**
 * Role name → persona id. ONE slug for the repo: identical to the alias
 * `fromAdo` mints for the same role text (lower_snake_case, 40 chars), so
 * "Business Development Manager" typed into the planner and the same phrase
 * read out of an ADO pre-req are the same persona — a parity unit test pins
 * it. Non-conforming input is returned as-is; the caller validates.
 */
export function slugRole(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/, '');
}

/**
 * Why `name` is not an env-var NAME — null when it is one. The same three
 * rules the personas validator applies (schema.ts `smellsLikeSecret`), said
 * in the second person because a human is typing into a field.
 */
export function envNameError(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) return 'must be an ENV VAR NAME (A-Z, digits, underscores)';
  if (name.length > 64) return 'too long for an env name';
  if (name.length >= 12 && !name.includes('_')) {
    return 'looks like a pasted secret, not a name — names are worded, like SFDC_UAT_USERNAME';
  }
  return null;
}

/** One role to add, and the login it plays (omitted = a new login named after the role). */
export interface PersonaRequest {
  role: string;
  account?: string;
}

export interface AddPersonasResult {
  /** The roster with the new roles and logins merged in — a copy; the input is untouched. */
  roster: PersonasDoc;
  created: {
    /** Persona ids created, in request order. */
    added: string[];
    /** Requested roles that were already on the roster (nothing was changed for them). */
    existing: string[];
    /** persona id → the login it plays. */
    bound: Record<string, string>;
    /** Logins that did not exist and were declared. */
    accountsCreated: string[];
  };
  /** account id → its `.env` block (NAMES only), one per NEW login. */
  envBlock: Record<string, string[]>;
}

/**
 * Roles → personas bound to accounts (docs/DESIGN-ROLES-ACCOUNTS.md). Each
 * request becomes a persona `slugRole(role)` that "logs in as" either the
 * account it names (existing, or declared here) or a new one named after the
 * role. A role already on the roster is reported and left alone — this is
 * called on every save, so it must be idempotent.
 *
 * Throws on anything that would make a bad login: a role that yields no
 * usable id, an account id that is not lower_snake_case (it becomes the env
 * prefix), or an account id already taken by a PERSONA of that name.
 */
export function addPersonas(roster: PersonasDoc, requests: readonly PersonaRequest[]): AddPersonasResult {
  // A roster read off disk may be missing either map — the validator runs on
  // the way OUT, not in. The clone is deep: the input is never touched.
  const clone = structuredClone(roster);
  const doc: PersonasDoc = { ...clone, personas: { ...clone.personas }, accounts: { ...clone.accounts } };
  const accounts = doc.accounts ?? {}; // same object — `accounts` is optional on the type only

  const added: string[] = [];
  const existing: string[] = [];
  const accountsCreated: string[] = [];
  const bound: Record<string, string> = {};

  for (const req of requests) {
    const role = req.role.trim();
    if (!role) throw new Error('roles: give at least one role name');
    const id = slugRole(role);
    if (!PERSONA_ID_RE.test(id)) throw new Error(`'${role}' does not yield a usable persona id`);
    if (doc.personas[id]) { existing.push(id); continue; }

    const account = (req.account ?? id).trim();
    if (!PERSONA_ID_RE.test(account)) {
      throw new Error(`account '${account}' for '${role}' must be lower_snake_case (it becomes the env prefix)`);
    }
    if (!accounts[account]) {
      accounts[account] = { auth: 'frontdoor' };
      accountsCreated.push(account);
    }
    doc.personas[id] = { kind: 'internal', role, account };
    added.push(id);
    bound[id] = account;
  }

  const envBlock: Record<string, string[]> = {};
  // One block per new LOGIN, not per role: three roles sharing a sandbox
  // user are three lines of `# …` and one set of credentials.
  for (const account of accountsCreated) envBlock[account] = envBlockFor(doc, account);

  return { roster: doc, created: { added, existing, bound, accountsCreated }, envBlock };
}

/**
 * Point ONE credential of ONE login at a different env-var name (the team's
 * existing `.env` vocabulary). Names only — `.env` itself is never read or
 * written. `accountId` names a DECLARED account; every role that logs in as
 * it follows automatically, because the name lives on the login.
 *
 * `newName` empty clears the mapping ("this system has no token"), except
 * the username — every login has one. Returns a copy; throws with the reason
 * on a bad name, and on a name already spoken for by another login (which
 * would silently make two logins share a credential).
 */
export function renameEnvName(
  roster: PersonasDoc,
  accountId: string,
  slot: CredSlot,
  newName: string,
): PersonasDoc {
  const doc = structuredClone(roster);
  const key = ENV_KEY[slot];
  const target: AccountDef | undefined = doc.accounts?.[accountId];
  if (!target) throw new Error(`account '${accountId}' is not declared in personas.json`);

  const name = newName.trim();
  if (!name) {
    if (slot === 'username') throw new Error(`${key} is required for authenticated personas`);
    // An explicit '' is the override that says "this login does not use it".
    target[key] = '';
    return doc;
  }

  const bad = envNameError(name);
  if (bad) throw new Error(`${key}: ${bad}`);
  const owner = envNameOwners(doc).get(name);
  if (owner && owner.login !== accountId) {
    throw new Error(`${key}: ${name} is already the ${owner.slot} name of login '${owner.login}' — two logins cannot share a credential`);
  }
  target[key] = name;
  return doc;
}

/** Every env name a login already claims → who claims it (first wins). */
function envNameOwners(doc: PersonasDoc): Map<string, { login: string; slot: CredSlot }> {
  const owners = new Map<string, { login: string; slot: CredSlot }>();
  const claim = (name: string | undefined, login: string, slot: CredSlot): void => {
    if (name && !owners.has(name)) owners.set(name, { login, slot });
  };
  for (const [id, a] of Object.entries(doc.accounts ?? {})) {
    const names = accountEnvNames(id, a);
    for (const slot of CRED_SLOTS) claim(names[slot], id, slot);
  }
  // Personas own no env names: a role borrows its account's (sprint 4.4).
  return owners;
}

/**
 * name → is it SET in this `.env` text? Presence only: values never leave
 * the reader (the planner's credential dots are booleans by design). Parsing
 * is dotenv's own, so `export FOO=…`, quotes, comments and blank values
 * behave exactly as they will at runtime — a name present but empty is NOT
 * set, which is what an unfilled `.env.example` block looks like.
 */
export function envPresence(envText: string, names: readonly string[]): Record<string, boolean> {
  const parsed: Record<string, string | undefined> = envText ? parseDotenv(envText) : {};
  const out: Record<string, boolean> = {};
  for (const name of names) {
    if (!name) continue;
    out[name] = (parsed[name] ?? '').trim() !== '';
  }
  return out;
}
