/**
 * Storage-state file conventions (founding doc §4.3).
 *
 * One storageState per persona PER DOMAIN — Salesforce sid cookies are
 * domain-scoped, so an org session and a *.my.site.com portal session are
 * different files. Parallel workers mutating server state get one user
 * per worker slot, keyed on testInfo.parallelIndex.
 */

import * as path from 'path';

export const AUTH_DIR = '.auth';

/** `.auth/admin.json`, `.auth/partner.json`, … */
export function statePathFor(persona: string): string {
  return path.join(AUTH_DIR, `${slug(persona)}.json`);
}

/** `.auth/admin-w0.json` — per-worker variant for shared-org parallel runs. */
export function workerStatePathFor(persona: string, parallelIndex: number): string {
  if (!Number.isInteger(parallelIndex) || parallelIndex < 0) {
    throw new Error(`parallelIndex must be a non-negative integer, got ${parallelIndex}`);
  }
  return path.join(AUTH_DIR, `${slug(persona)}-w${parallelIndex}.json`);
}

/** Empty state for guest (unauthenticated) portal projects. */
export const GUEST_STATE = { cookies: [], origins: [] } as const;

/**
 * How long a cached storageState is trusted before we re-authenticate.
 *
 * This is a GUESS, deliberately: Salesforce session length is an org setting
 * (commonly 2h, configurable from 15 minutes up), and the `sid` cookie is a
 * session cookie, so the file itself carries no expiry to read. Two hours
 * matches the common default; override per-project with SESSION_MAX_AGE_MS.
 *
 * Being wrong is cheap in one direction only — too short costs one extra
 * login, too long costs a confusing mid-test redirect to a login page. Bias
 * short.
 */
export const DEFAULT_SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000;

export interface SessionFreshness {
  fresh: boolean;
  ageMs: number;
  /** Present when stale — the line to log, naming the file and both ages. */
  reason?: string;
}

/**
 * Is a cached session file young enough to trust? Pure given `now` and the
 * file's mtime, so it tests without a clock or a browser.
 *
 * Not a liveness check: a session revoked or password-changed inside the
 * window still looks fresh here. It converts the COMMON failure (an old file
 * from a previous day) from a mystery redirect into a named, expected
 * re-login.
 */
export function sessionFreshness(
  statePath: string,
  mtimeMs: number,
  now: number,
  maxAgeMs: number = DEFAULT_SESSION_MAX_AGE_MS,
): SessionFreshness {
  const ageMs = now - mtimeMs;
  if (ageMs <= maxAgeMs) return { fresh: true, ageMs };
  return {
    fresh: false,
    ageMs,
    reason: `${statePath} is ${humanMs(ageMs)} old (max ${humanMs(maxAgeMs)}) — re-authenticating`,
  };
}

/** Reads SESSION_MAX_AGE_MS; falls back to the default when unset/invalid. */
export function sessionMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SESSION_MAX_AGE_MS?.trim();
  if (!raw) return DEFAULT_SESSION_MAX_AGE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`SESSION_MAX_AGE_MS must be a non-negative number of milliseconds, got '${raw}'`);
  }
  return n;
}

function humanMs(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)}h`;
  return `${(ms / 86_400_000).toFixed(1)}d`;
}

function slug(persona: string): string {
  const s = persona.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!s) throw new Error('persona name must be non-empty');
  return s;
}
