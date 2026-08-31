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

function slug(persona: string): string {
  const s = persona.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  if (!s) throw new Error('persona name must be non-empty');
  return s;
}
