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

export interface PersonaDef {
  kind: PersonaKind;
  /** Site key (required for portal, optional for guest). */
  site?: string;
  role?: string;
  profile?: string;
  license?: string;
  permissionSets?: string[];
  /** Env-var NAMES, never values. */
  usernameEnv?: string;
  passwordEnv?: string;
  tokenEnv?: string;
  /** TOTP/MFA shared secret env NAME — needed when the org enforces MFA on UI logins. */
  totpEnv?: string;
  auth?: AuthMethod;
  /** Clone accounts available for parallel workers (SF_X_USERNAME_W0…). */
  poolSize?: number;
}

export interface PersonasDoc {
  org: { instanceUrlEnv: string };
  sites?: Record<string, { urlEnv: string }>;
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
  'kind', 'site', 'role', 'profile', 'license', 'permissionSets',
  'usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv', 'auth', 'poolSize',
]);

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

  if (!d.personas || typeof d.personas !== 'object' || Object.keys(d.personas).length === 0) {
    errors.push('personas must be a non-empty object');
    return { ok: false, errors };
  }

  for (const [id, p] of Object.entries(d.personas)) {
    const at = `personas.${id}`;
    if (!PERSONA_ID_RE.test(id)) errors.push(`${at}: id must be lower_snake_case`);
    if (!p || typeof p !== 'object') { errors.push(`${at}: must be an object`); continue; }

    for (const [k, v] of Object.entries(p as unknown as Record<string, unknown>)) {
      if (!ALLOWED_KEYS.has(k)) errors.push(`${at}.${k}: unknown key (no inline credentials — use *Env names)`);
      if (smellsLikeSecret(k, v)) errors.push(`${at}.${k}: looks like an inline secret/value — *Env fields carry env-var NAMES only`);
    }

    if (!KINDS.includes(p.kind)) errors.push(`${at}.kind: must be one of ${KINDS.join('|')}`);
    if (p.kind === 'portal' && !p.site) errors.push(`${at}: portal personas require a site`);
    if (p.site && !sites[p.site]) errors.push(`${at}.site: '${p.site}' not declared in sites`);

    if (p.kind === 'guest') {
      if (p.usernameEnv || p.passwordEnv || p.tokenEnv || p.totpEnv) errors.push(`${at}: guest personas are unauthenticated — no credential envs`);
    } else {
      if (!p.usernameEnv) errors.push(`${at}.usernameEnv: required for ${p.kind} personas`);
      if (p.auth && !AUTHS.includes(p.auth)) errors.push(`${at}.auth: must be one of ${AUTHS.join('|')}`);
      if (p.kind === 'portal' && p.auth === 'frontdoor') {
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
