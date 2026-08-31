/**
 * Typed, validated access to Salesforce test-environment config.
 * E2E specs gate on hasOrgConfig() and skip cleanly when unset,
 * so `npm test` is always green on a fresh clone.
 */
import { compact } from './compact';

export interface SfEnv {
  instanceUrl: string;
  accessToken?: string;
  username?: string;
  password?: string;
  loginUrl: string;
  apiVersion: string;
  siteUrl?: string;
}

/** Read config from an env map (injectable for tests). Returns null when the org isn't configured. */
export function loadEnv(env: NodeJS.ProcessEnv = process.env): SfEnv | null {
  const instanceUrl = clean(env.SF_INSTANCE_URL);
  if (!instanceUrl) return null;
  return compact({
    instanceUrl: stripTrailingSlash(instanceUrl),
    accessToken: clean(env.SF_ACCESS_TOKEN),
    username: clean(env.SF_USERNAME),
    password: clean(env.SF_PASSWORD),
    loginUrl: stripTrailingSlash(clean(env.SF_LOGIN_URL) ?? 'https://test.salesforce.com'),
    apiVersion: clean(env.SF_API_VERSION) ?? 'v61.0',
    siteUrl: optional(clean(env.SF_SITE_URL), stripTrailingSlash),
  });
}

/** True when e2e tests can run at all. */
export function hasOrgConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = loadEnv(env);
  return !!cfg && (!!cfg.accessToken || (!!cfg.username && !!cfg.password));
}

/** Throw with a useful message when e2e config is required but absent. */
export function requireEnv(env: NodeJS.ProcessEnv = process.env): SfEnv {
  const cfg = loadEnv(env);
  if (!cfg) {
    throw new Error(
      'Salesforce env not configured: set SF_INSTANCE_URL (and SF_ACCESS_TOKEN or SF_USERNAME/SF_PASSWORD) in .env — see .env.example',
    );
  }
  return cfg;
}

function clean(v: string | undefined): string | undefined {
  const t = v?.trim();
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- '' deliberately counts as unset
  return t || undefined;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function optional<T, R>(v: T | undefined, fn: (v: T) => R): R | undefined {
  return v === undefined ? undefined : fn(v);
}
