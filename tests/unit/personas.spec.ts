/**
 * personas.json schema + registry: the no-secrets-in-JSON contract, pool
 * suffixing, legacy env fallback, and actionable failure messages.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { validatePersonas } from '../../src/personas/schema';
import { PersonaRegistry } from '../../src/personas/registry';

const good = () => ({
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: { portal: { urlEnv: 'SF_SITE_URL' } },
  personas: {
    admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD', tokenEnv: 'SF_ADMIN_TOKEN', auth: 'frontdoor' },
    sales_user: { kind: 'internal', usernameEnv: 'SF_SALES_USERNAME', passwordEnv: 'SF_SALES_PASSWORD', poolSize: 4 },
    portal_user: { kind: 'portal', site: 'portal', usernameEnv: 'SF_PORTAL_USERNAME', tokenEnv: 'SF_PORTAL_TOKEN', auth: 'singleaccess' },
    guest: { kind: 'guest', site: 'portal' },
  },
});

test.describe('validatePersonas', () => {
  test('the repo personas.json is valid (ships working)', () => {
     
    const doc = require(path.resolve(__dirname, '../../personas.json'));
    const r = validatePersonas(doc);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('a well-formed doc passes', () => {
    expect(validatePersonas(good()).ok).toBe(true);
  });

  test('non-guest persona without usernameEnv is rejected', () => {
    const d = good();
    delete (d.personas.admin as Record<string, unknown>).usernameEnv;
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('admin.usernameEnv');
  });

  test('portal persona requires a declared site', () => {
    const d = good();
    delete (d.personas.portal_user as Record<string, unknown>).site;
    expect(validatePersonas(d).errors.join()).toContain('portal personas require a site');

    const d2 = good();
    (d2.personas.portal_user as Record<string, unknown>).site = 'nope';
    expect(validatePersonas(d2).errors.join()).toContain("'nope' not declared");
  });

  test('portal + classic frontdoor is rejected (site sessions need singleaccess)', () => {
    const d = good();
    (d.personas.portal_user as Record<string, unknown>).auth = 'frontdoor';
    expect(validatePersonas(d).errors.join()).toContain('singleaccess');
  });

  test('inline secrets are rejected: *Env fields must be env-var NAMES', () => {
    const d = good();
    (d.personas.admin as Record<string, unknown>).passwordEnv = 'hunter2!secret';
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('inline secret');
  });

  test('credential-bearing keys are rejected outright', () => {
    const d = good();
    (d.personas.admin as Record<string, unknown>).password = 'hunter2';
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('unknown key');
  });

  test('guest personas carry no credential envs', () => {
    const d = good();
    (d.personas.guest as Record<string, unknown>).usernameEnv = 'SF_GUEST_USERNAME';
    expect(validatePersonas(d).errors.join()).toContain('unauthenticated');
  });

  test('poolSize must be a positive integer', () => {
    const d = good();
    (d.personas.sales_user as Record<string, unknown>).poolSize = 0;
    expect(validatePersonas(d).ok).toBe(false);
  });
});

test.describe('PersonaRegistry', () => {
  const reg = () => PersonaRegistry.fromDoc(good());

  test('unknown persona fails fast, listing known ids', () => {
    expect(() => reg().get('ghost')).toThrow(/known: admin, sales_user, portal_user, guest/);
  });

  test('pool suffixing: worker index maps into the clone pool (modulo)', () => {
    const names = reg().envNamesFor('sales_user', 6); // poolSize 4 → _W2
    expect(names.username).toBe('SF_SALES_USERNAME_W2');
    expect(names.password).toBe('SF_SALES_PASSWORD_W2');
  });

  test('poolSize 1 personas ignore the worker index', () => {
    expect(reg().envNamesFor('admin', 3).username).toBe('SF_ADMIN_USERNAME');
  });

  test('totpEnv: parsed, pool-suffixed, names-only enforced, refused on guests', () => {
    const doc = good() as { personas: Record<string, Record<string, unknown>> };
    doc.personas.admin!.totpEnv = 'SF_ADMIN_TOTP_SECRET';
    doc.personas.sales_user!.totpEnv = 'SF_SALES_TOTP_SECRET'; // poolSize 4
    const r = PersonaRegistry.fromDoc(doc);
    expect(r.envNamesFor('admin').totp).toBe('SF_ADMIN_TOTP_SECRET');
    expect(r.envNamesFor('sales_user', 6).totp).toBe('SF_SALES_TOTP_SECRET_W2');

    // Inline-looking values are rejected — env NAMES only, same as the rest:
    const bad = good() as { personas: Record<string, Record<string, unknown>> };
    bad.personas.admin!.totpEnv = 'JBSWY3DPEHPK3PXP'; // smells like the secret itself
    expect(() => PersonaRegistry.fromDoc(bad)).toThrow(/looks like an inline secret|NAMES only/);

    const guest = good() as { personas: Record<string, Record<string, unknown>> };
    guest.personas.guest!.totpEnv = 'GUEST_TOTP';
    expect(() => PersonaRegistry.fromDoc(guest)).toThrow(/guest personas are unauthenticated/);
  });

  test('resolveCreds reads values from the env map', () => {
    const c = reg().resolveCreds('sales_user', { SF_SALES_USERNAME_W2: 'u2@x', SF_SALES_PASSWORD_W2: 'pw' }, 6);
    expect(c).toEqual({ username: 'u2@x', password: 'pw', token: undefined });
  });

  test('legacy fallback: admin resolves SF_USERNAME/SF_PASSWORD/SF_ACCESS_TOKEN', () => {
    const c = reg().resolveCreds('admin', { SF_USERNAME: 'a@x', SF_PASSWORD: 'p', SF_ACCESS_TOKEN: 't' });
    expect(c).toEqual({ username: 'a@x', password: 'p', token: 't' });
  });

  test('hasCreds: token alone suffices; guest always true; empty env false', () => {
    expect(reg().hasCreds('admin', { SF_ADMIN_TOKEN: 't' })).toBe(true);
    expect(reg().hasCreds('guest', {})).toBe(true);
    expect(reg().hasCreds('sales_user', {})).toBe(false);
  });

  test('authDomainFor: site personas use the site URL, slashes stripped', () => {
    const env = { SF_SITE_URL: 'https://acme.my.site.com/portal/', SF_INSTANCE_URL: 'https://acme.my.salesforce.com/' };
    expect(reg().authDomainFor('portal_user', env)).toBe('https://acme.my.site.com/portal');
    expect(reg().authDomainFor('admin', env)).toBe('https://acme.my.salesforce.com');
  });

  test('authDomainFor without env names the exact variable to set', () => {
    expect(() => reg().authDomainFor('portal_user', {})).toThrow(/SF_SITE_URL/);
    expect(() => reg().authDomainFor('admin', {})).toThrow(/SF_INSTANCE_URL/);
  });

  test('statePathForPersona: pooled personas get worker-suffixed files', () => {
    expect(reg().statePathForPersona('sales_user', 6)).toContain('sales_user-w2.json');
    expect(reg().statePathForPersona('admin', 6)).toContain('admin.json');
  });

  test('missingEnvHint names the exact vars to set', () => {
    const hint = reg().missingEnvHint('portal_user', {});
    expect(hint).toContain('SF_PORTAL_TOKEN');
    expect(hint).toContain('SF_PORTAL_USERNAME');
  });

  test('fromDoc surfaces every validation error at once', () => {
    const bad = good();
    delete (bad.personas.admin as Record<string, unknown>).usernameEnv;
    (bad.personas.portal_user as Record<string, unknown>).auth = 'frontdoor';
    expect(() => PersonaRegistry.fromDoc(bad)).toThrow(/admin\.usernameEnv[\s\S]*singleaccess/);
  });
});
