import { test, expect } from '@playwright/test';
import { loadEnv, hasOrgConfig, requireEnv } from '../../src/utils/env';

test.describe('env', () => {
  test('returns null when SF_INSTANCE_URL unset (e2e gates off cleanly)', () => {
    expect(loadEnv({})).toBeNull();
    expect(loadEnv({ SF_INSTANCE_URL: '   ' })).toBeNull();
  });

  test('strips trailing slashes and applies defaults', () => {
    const cfg = requireEnv({ SF_INSTANCE_URL: 'https://x.my.salesforce.com/' });
    expect(cfg.instanceUrl).toBe('https://x.my.salesforce.com');
    expect(cfg.loginUrl).toBe('https://test.salesforce.com');
    expect(cfg.apiVersion).toBe('v61.0');
    expect(cfg.siteUrl).toBeUndefined();
  });

  test('hasOrgConfig requires a token OR username+password', () => {
    const base = { SF_INSTANCE_URL: 'https://x.my.salesforce.com' };
    expect(hasOrgConfig(base)).toBe(false);
    expect(hasOrgConfig({ ...base, SF_ACCESS_TOKEN: 't' })).toBe(true);
    expect(hasOrgConfig({ ...base, SF_USERNAME: 'u' })).toBe(false);
    expect(hasOrgConfig({ ...base, SF_USERNAME: 'u', SF_PASSWORD: 'p' })).toBe(true);
  });

  test('requireEnv throws a message pointing at .env.example', () => {
    expect(() => requireEnv({})).toThrow(/\.env\.example/);
  });

  test('site URL trailing slash is stripped too', () => {
    const cfg = requireEnv({
      SF_INSTANCE_URL: 'https://x.my.salesforce.com',
      SF_SITE_URL: 'https://x.my.site.com/customers/',
    });
    expect(cfg.siteUrl).toBe('https://x.my.site.com/customers');
  });
});
