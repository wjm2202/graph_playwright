/**
 * Persona registry — loads personas.json, resolves credentials from the
 * environment (env-var NAMES in JSON → values from .env), and knows which
 * domain each persona authenticates against.
 *
 * Worker pools (founding doc §4.4, parallel_workers__shared_users__banned):
 * a persona with poolSize N has clone accounts in env vars suffixed _W0…_W(N-1)
 * (e.g. SF_SALES_USERNAME_W2). Worker i uses clone i % N. poolSize 1 personas
 * resolve their base env vars regardless of worker.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  accountEnvNames as deriveEnvNames, accountIdOf, effectivePersona, envBlockFor, rolesOfAccount, validatePersonas,
  type AccountDef, type AuthMethod, type CredEnvNames, type PersonaDef, type PersonasDoc,
} from './schema';
import { compact } from '../utils/compact';
import { statePathFor, workerStatePathFor } from '../auth/storage';

export interface ResolvedCreds {
  username?: string;
  password?: string;
  token?: string;
}

export interface PersonaRuntime {
  id: string;
  def: PersonaDef;
  /** Which env-var names credentials come from (after pool suffixing). */
  envNames: { username?: string; password?: string; token?: string; totp?: string };
}

export class PersonaRegistry {
  private constructor(readonly doc: PersonasDoc, readonly sourcePath: string) {}

  /** Load + validate personas.json (throws with every validation error listed). */
  static load(filePath = path.resolve('personas.json')): PersonaRegistry {
    const raw = fs.readFileSync(filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`personas.json is not valid JSON (${filePath}): ${(e as Error).message}`);
    }
    return PersonaRegistry.fromDoc(parsed, filePath);
  }

  /** Build from an in-memory doc (injectable for tests). */
  static fromDoc(parsed: unknown, sourcePath = '(inline)'): PersonaRegistry {
    const result = validatePersonas(parsed);
    if (!result.ok) {
      throw new Error(`personas.json invalid (${sourcePath}):\n - ${result.errors.join('\n - ')}`);
    }
    return new PersonaRegistry(parsed as PersonasDoc, sourcePath);
  }

  ids(): string[] {
    return Object.keys(this.doc.personas);
  }

  /**
   * The persona as Cast sees it — role fields from the persona, credentials
   * / auth / pool from its ACCOUNT (env names derived from the account id,
   * docs/DESIGN-ROLES-ACCOUNTS.md). Legacy self-wired personas come back as-is.
   */
  get(id: string): PersonaDef {
    const def = effectivePersona(this.doc, id);
    if (!def) {
      throw new Error(`Unknown persona '${id}' — known: ${this.ids().join(', ')} (${this.sourcePath})`);
    }
    return def;
  }

  /** The login a persona uses — its account id, or itself when self-wired. */
  accountOf(id: string): string {
    this.get(id);
    return accountIdOf(this.doc, id);
  }

  /** Declared account ids (legacy self-wired personas are not listed here). */
  accountIds(): string[] {
    return Object.keys(this.doc.accounts ?? {});
  }

  account(accountId: string): AccountDef | undefined {
    return this.doc.accounts?.[accountId];
  }

  /** Base env names (no pool suffix) an account reads. */
  accountEnvNames(accountId: string): CredEnvNames {
    return deriveEnvNames(accountId, this.account(accountId));
  }

  /** Personas (roles) that log in as this account. */
  rolesOf(accountId: string): string[] {
    return rolesOfAccount(this.doc, accountId);
  }

  /** Paste-ready .env lines for one account (names only). */
  envBlockFor(accountId: string): string[] {
    return envBlockFor(this.doc, accountId);
  }

  /** Env-var names for a persona's credentials, applying pool suffixing. */
  envNamesFor(id: string, workerIndex?: number): PersonaRuntime['envNames'] {
    const def = this.get(id);
    const pool = def.poolSize ?? 1;
    const suffix =
      pool > 1 && workerIndex !== undefined ? `_W${((workerIndex % pool) + pool) % pool}` : '';
    const sfx = (name?: string) => (name ? `${name}${suffix}` : undefined);
    return compact({ username: sfx(def.usernameEnv), password: sfx(def.passwordEnv), token: sfx(def.tokenEnv), totp: sfx(def.totpEnv) });
  }

  /**
   * Resolve credentials from the environment. Legacy fallback: the `admin`
   * persona also accepts SF_USERNAME/SF_PASSWORD/SF_ACCESS_TOKEN so a
   * single-user .env from the starter keeps working.
   */
  resolveCreds(id: string, env: NodeJS.ProcessEnv = process.env, workerIndex?: number): ResolvedCreds {
    const def = this.get(id);
    if (def.kind === 'guest') return {};
    const names = this.envNamesFor(id, workerIndex);
    const legacy = id === 'admin';
    return compact({
      username: clean(names.username ? env[names.username] : undefined) ?? (legacy ? clean(env.SF_USERNAME) : undefined),
      password: clean(names.password ? env[names.password] : undefined) ?? (legacy ? clean(env.SF_PASSWORD) : undefined),
      token: clean(names.token ? env[names.token] : undefined) ?? (legacy ? clean(env.SF_ACCESS_TOKEN) : undefined),
    });
  }

  /** True when the persona can authenticate right now (token or user+pass). */
  hasCreds(id: string, env: NodeJS.ProcessEnv = process.env, workerIndex?: number): boolean {
    const def = this.get(id);
    if (def.kind === 'guest') return true;
    const c = this.resolveCreds(id, env, workerIndex);
    return !!c.token || (!!c.username && !!c.password);
  }

  /**
   * The domain this persona's session lives on (cookies are domain-scoped —
   * one storageState per persona per domain, founding doc §4.3).
   */
  authDomainFor(id: string, env: NodeJS.ProcessEnv = process.env): string {
    const def = this.get(id);
    if (def.site) {
      const site = this.doc.sites?.[def.site];
      const url = site ? clean(env[site.urlEnv]) : undefined;
      if (!url) {
        throw new Error(
          `Persona '${id}' needs site '${def.site}' — set ${site?.urlEnv ?? '?'} in .env`,
        );
      }
      return stripSlash(url);
    }
    const url = clean(env[this.doc.org.instanceUrlEnv]);
    if (!url) throw new Error(`Set ${this.doc.org.instanceUrlEnv} in .env (org instance URL)`);
    return stripSlash(url);
  }

  /**
   * storageState file path for a persona (worker-suffixed when pooled).
   * Keyed by ACCOUNT: two roles played by one login share one session file.
   */
  statePathForPersona(id: string, workerIndex?: number): string {
    const def = this.get(id);
    const account = this.accountOf(id);
    const pool = def.poolSize ?? 1;
    return pool > 1 && workerIndex !== undefined
      ? workerStatePathFor(account, workerIndex % pool)
      : statePathFor(account);
  }

  /** The env names that would authenticate this persona but are unset. */
  missingEnvNames(id: string, env: NodeJS.ProcessEnv = process.env, workerIndex?: number): string[] {
    if (this.get(id).kind === 'guest') return [];
    const names = this.envNamesFor(id, workerIndex);
    const c = this.resolveCreds(id, env, workerIndex);
    const missing: string[] = [];
    if (!c.token && names.token) missing.push(names.token);
    if (!c.username && names.username) missing.push(names.username);
    if (!c.password && names.password) missing.push(names.password);
    return missing;
  }

  /** Actionable description of what's missing for a persona to authenticate. */
  missingEnvHint(id: string, env: NodeJS.ProcessEnv = process.env, workerIndex?: number): string {
    const missing = this.missingEnvNames(id, env, workerIndex);
    return `persona '${id}' unauthenticated — set ${missing.join(' or ') || 'credentials'} in .env (token preferred; see .env.example)`;
  }

  /**
   * persona → auth method, for graph validation: a `login_as` edge may
   * DECLARE how a session is acquired, but this map is what Cast obeys.
   * Personas leaving `auth` unset are omitted (nothing to contradict).
   */
  authMethods(): Record<string, AuthMethod | undefined> {
    const out: Record<string, AuthMethod | undefined> = {};
    for (const id of this.ids()) {
      const auth = this.get(id).auth;
      if (auth) out[id] = auth;
    }
    return out;
  }

  /** .env name of the org instance URL (SF_INSTANCE_URL by convention). */
  orgUrlEnvName(): string {
    return this.doc.org.instanceUrlEnv;
  }

  /** .env name of the persona's site URL, when it lives on one (Siebel, Experience Cloud). */
  siteUrlEnvName(id: string): { site: string; env: string } | undefined {
    const def = this.get(id);
    if (!def.site) return undefined;
    const site = this.doc.sites?.[def.site];
    return site ? { site: def.site, env: site.urlEnv } : undefined;
  }
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' deliberately counts as unset
  return t || undefined;
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}
