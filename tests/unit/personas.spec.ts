/**
 * personas.json schema + registry: the no-secrets-in-JSON contract, pool
 * suffixing, and actionable failure messages.
 *
 * Sprint 4.4 removed the legacy self-wired persona (credential env names
 * directly on a persona, the `admin` SF_USERNAME/SF_PASSWORD fallback):
 * every internal/portal persona names an ACCOUNT, and the account owns the
 * wiring. The rejections below are the loud errors that say so.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { accountEnvNames, envBlockFor, envPrefixFor, validatePersonas, type PersonasDoc } from '../../src/personas/schema';
import { PersonaRegistry } from '../../src/personas/registry';

const good = () => ({
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: { portal: { urlEnv: 'SF_SITE_URL' } },
  // The derived names are the same ones the old self-wired personas spelled
  // out by hand: SF_<ACCOUNT>_USERNAME/_PASSWORD/_TOKEN/_TOTP_SECRET.
  accounts: {
    admin: { auth: 'frontdoor' },
    sales: { poolSize: 4 },
    portal: { auth: 'singleaccess' },
  },
  personas: {
    admin: { kind: 'internal', account: 'admin' },
    sales_user: { kind: 'internal', account: 'sales' },
    portal_user: { kind: 'portal', site: 'portal', account: 'portal' },
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

  test('a non-guest persona without an account is rejected, and the error names the fix', () => {
    const d = good();
    delete (d.personas.admin as Record<string, unknown>).account;
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    const err = r.errors.join('\n');
    expect(err).toContain('personas.admin.account: required');
    expect(err).toContain('accounts["admin"]');            // what to add
    expect(err).toContain('personas["admin"].account');     // and what to point at it
  });

  test('credential env names ON A PERSONA are refused, naming the account to move them to', () => {
    for (const key of ['usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv']) {
      const d = good();
      (d.personas.admin as Record<string, unknown>)[key] = 'SF_ADMIN_THING';
      const err = validatePersonas(d).errors.join('\n');
      expect(err, key).toContain(`personas.admin.${key}: credential env names live on the ACCOUNT`);
      expect(err, key).toContain('sprint 4.4 removed self-wired personas');
    }
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
    // The ACCOUNT's auth is what Cast uses, so that is what the rule reads.
    const d = good() as unknown as { accounts: Record<string, Record<string, unknown>> };
    d.accounts.portal!.auth = 'frontdoor';
    expect(validatePersonas(d).errors.join()).toContain('singleaccess');
  });

  test('inline secrets are rejected: *Env fields must be env-var NAMES', () => {
    const d = good() as unknown as { accounts: Record<string, Record<string, unknown>> };
    d.accounts.admin!.passwordEnv = 'hunter2!secret';
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

  test('guest personas carry no credential envs and no account', () => {
    const d = good();
    (d.personas.guest as Record<string, unknown>).usernameEnv = 'SF_GUEST_USERNAME';
    expect(validatePersonas(d).errors.join()).toContain('credential env names live on the ACCOUNT');
    const d2 = good();
    (d2.personas.guest as Record<string, unknown>).account = 'admin';
    expect(validatePersonas(d2).errors.join()).toContain('unauthenticated');
  });

  test('poolSize must be a positive integer', () => {
    const d = good();
    (d.personas.sales_user as Record<string, unknown>).poolSize = 0;
    expect(validatePersonas(d).ok).toBe(false);
  });

  test('every persona in the repo personas.json names an account (or is the guest)', () => {
     
    const doc = require(path.resolve(__dirname, '../../personas.json')) as PersonasDoc;
    const ids = Object.keys(doc.personas);
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) {
      const p = doc.personas[id]!;
      if (p.kind === 'guest') { expect(p.account, id).toBeUndefined(); continue; }
      expect(p.account, `persona '${id}' must name an account`).toBeTruthy();
      expect(doc.accounts?.[p.account!], `account '${p.account}' must be declared`).toBeTruthy();
      for (const key of ['usernameEnv', 'passwordEnv', 'tokenEnv', 'totpEnv']) {
        expect(p as unknown as Record<string, unknown>, id).not.toHaveProperty(key);
      }
    }
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

  test('totpEnv: derived, pool-suffixed, names-only enforced, refused on guests', () => {
    const r = PersonaRegistry.fromDoc(good());
    expect(r.envNamesFor('admin').totp).toBe('SF_ADMIN_TOTP_SECRET');
    expect(r.envNamesFor('sales_user', 6).totp).toBe('SF_SALES_TOTP_SECRET_W2'); // poolSize 4

    // Inline-looking values are rejected — env NAMES only, same as the rest:
    const bad = good() as unknown as { accounts: Record<string, Record<string, unknown>> };
    bad.accounts.admin!.totpEnv = 'JBSWY3DPEHPK3PXP'; // smells like the secret itself
    expect(() => PersonaRegistry.fromDoc(bad)).toThrow(/looks like an inline secret|NAMES only/);

    const guest = good() as { personas: Record<string, Record<string, unknown>> };
    guest.personas.guest!.totpEnv = 'GUEST_TOTP';
    expect(() => PersonaRegistry.fromDoc(guest)).toThrow(/credential env names live on the ACCOUNT/);
  });

  test('resolveCreds reads values from the env map', () => {
    const c = reg().resolveCreds('sales_user', { SF_SALES_USERNAME_W2: 'u2@x', SF_SALES_PASSWORD_W2: 'pw' }, 6);
    expect(c).toEqual({ username: 'u2@x', password: 'pw', token: undefined });
  });

  test('the legacy admin fallback is GONE: SF_USERNAME/SF_PASSWORD/SF_ACCESS_TOKEN no longer log anyone in', () => {
    const c = reg().resolveCreds('admin', { SF_USERNAME: 'a@x', SF_PASSWORD: 'p', SF_ACCESS_TOKEN: 't' });
    expect(c).toEqual({ username: undefined, password: undefined, token: undefined });
    expect(reg().hasCreds('admin', { SF_USERNAME: 'a@x', SF_PASSWORD: 'p' })).toBe(false);
    // Its account's own names still do:
    expect(reg().resolveCreds('admin', { SF_ADMIN_TOKEN: 't' })).toEqual({ username: undefined, password: undefined, token: 't' });
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
    // The session file belongs to the LOGIN, not the role: `sales_user`
    // plays the `sales` account, so its state file is that account's.
    expect(reg().statePathForPersona('sales_user', 6)).toContain('sales-w2.json');
    expect(reg().statePathForPersona('admin', 6)).toContain('admin.json');
  });

  test('missingEnvHint names the exact vars to set', () => {
    const hint = reg().missingEnvHint('portal_user', {});
    expect(hint).toContain('SF_PORTAL_TOKEN');
    expect(hint).toContain('SF_PORTAL_USERNAME');
  });

  test('fromDoc surfaces every validation error at once', () => {
    const bad = good() as unknown as {
      accounts: Record<string, Record<string, unknown>>;
      personas: Record<string, Record<string, unknown>>;
    };
    delete bad.personas.admin!.account;
    bad.accounts.portal!.auth = 'frontdoor';
    expect(() => PersonaRegistry.fromDoc(bad)).toThrow(/admin\.account[\s\S]*singleaccess/);
  });
});

// ── roles → accounts → env (docs/DESIGN-ROLES-ACCOUNTS.md) ──────────────────

const withAccounts = (): PersonasDoc => ({
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: { portal: { urlEnv: 'SF_SITE_URL' } },
  accounts: {
    sales_rep: { auth: 'frontdoor' },
    sales_mgr: { auth: 'frontdoor', poolSize: 2 },
    crm_ops: { system: 'siebel', auth: 'ui' },
    legacy: { usernameEnv: 'OLD_USER', passwordEnv: 'OLD_PASS' },
  },
  personas: {
    client_associate: { kind: 'internal', role: 'Client Associate', account: 'sales_rep' },
    client_lead: { kind: 'internal', role: 'Client Lead', account: 'sales_mgr' },
    bdm: { kind: 'internal', role: 'Business Development Manager', account: 'sales_mgr' },
    siebel_agent: { kind: 'internal', role: 'CRM Agent', account: 'crm_ops' },
    old_timer: { kind: 'internal', role: 'Old Timer', account: 'legacy' },
    guest: { kind: 'guest', site: 'portal' },
  },
});

test.describe('accounts: the env convention', () => {
  test('prefix: salesforce → SF, other systems their own id', () => {
    expect(envPrefixFor()).toBe('SF');
    expect(envPrefixFor('salesforce')).toBe('SF');
    expect(envPrefixFor('siebel')).toBe('SIEBEL');
    expect(envPrefixFor('sap_crm')).toBe('SAP_CRM');
  });

  test('names derive from <PREFIX>_<ACCOUNT>; overrides win per field', () => {
    expect(accountEnvNames('sales_rep')).toEqual({
      username: 'SF_SALES_REP_USERNAME', password: 'SF_SALES_REP_PASSWORD',
      token: 'SF_SALES_REP_TOKEN', totp: 'SF_SALES_REP_TOTP_SECRET',
    });
    expect(accountEnvNames('crm_ops', { system: 'siebel' }).username).toBe('SIEBEL_CRM_OPS_USERNAME');
    // An id that already carries the prefix is not doubled:
    expect(accountEnvNames('siebel_admin', { system: 'siebel' }).username).toBe('SIEBEL_ADMIN_USERNAME');
    expect(accountEnvNames('sf_admin').username).toBe('SF_ADMIN_USERNAME');
    const legacy = accountEnvNames('legacy', { usernameEnv: 'OLD_USER', passwordEnv: 'OLD_PASS' });
    expect(legacy.username).toBe('OLD_USER');
    expect(legacy.token).toBe('SF_LEGACY_TOKEN'); // untouched fields still follow the convention
    // '' switches a credential OFF for that login (no token, no MFA):
    expect(accountEnvNames('plain', { tokenEnv: '', totpEnv: '' })).toEqual({ username: 'SF_PLAIN_USERNAME', password: 'SF_PLAIN_PASSWORD', token: '', totp: '' });
  });

  test("an empty override is 'not used' — accepted, dropped from the effective persona; username can never be empty", () => {
    const d = withAccounts();
    d.accounts!.sales_rep = { tokenEnv: '', totpEnv: '' };
    expect(validatePersonas(d).errors).toEqual([]);
    const eff = PersonaRegistry.fromDoc(d).get('client_associate');
    expect(eff.usernameEnv).toBe('SF_SALES_REP_USERNAME');
    expect('tokenEnv' in eff).toBe(false);
    expect('totpEnv' in eff).toBe(false);
    expect(envBlockFor(d, 'sales_rep')).toEqual(['# sales_rep — salesforce login for: Client Associate', 'SF_SALES_REP_USERNAME=', 'SF_SALES_REP_PASSWORD=']);
    d.accounts!.sales_rep = { usernameEnv: '' };
    expect(validatePersonas(d).errors.join()).toContain('usernameEnv: cannot be empty');
  });

  test('a well-formed roles → accounts doc passes; the repo file is in that shape', () => {
    expect(validatePersonas(withAccounts()).errors).toEqual([]);
     
    const repo = require(path.resolve(__dirname, '../../personas.json')) as PersonasDoc;
    expect(Object.keys(repo.accounts ?? {}).length).toBeGreaterThan(0);
    // The five Salesforce roles the test cases name, each on its own Salesforce login:
    for (const id of ['client_associate', 'client_lead', 'business_development_manager', 'billing_collections', 'business_admin']) {
      expect(repo.personas[id]?.account, id).toBeTruthy();
      expect(repo.accounts?.[repo.personas[id]!.account!], `account of ${id}`).toBeTruthy();
    }
  });

  test('a persona naming an undeclared account is rejected (typo ≠ new login)', () => {
    const d = withAccounts();
    d.personas.client_lead!.account = 'sales_mgrr';
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain("'sales_mgrr' is not declared in accounts");
  });

  test('*Env wiring on a persona is rejected outright — the account owns it', () => {
    const d = withAccounts() as unknown as { personas: Record<string, Record<string, unknown>> };
    d.personas.client_lead!.usernameEnv = 'SF_X_USERNAME';
    expect(validatePersonas(d).errors.join()).toContain('credential env names live on the ACCOUNT');
  });

  test('accounts reject unknown keys, inline secrets, bad system ids, bad pools', () => {
    const d = withAccounts() as unknown as { accounts: Record<string, Record<string, unknown>> };
    d.accounts.sales_rep!.password = 'hunter2';
    d.accounts.sales_mgr!.usernameEnv = 'not a name';
    d.accounts.crm_ops!.system = 'Siebel CRM';
    d.accounts.legacy!.poolSize = 0;
    const errs = validatePersonas(d).errors.join('\n');
    expect(errs).toContain('accounts.sales_rep.password: unknown key');
    expect(errs).toContain('accounts.sales_mgr.usernameEnv: looks like an inline secret');
    expect(errs).toContain('accounts.crm_ops.system');
    expect(errs).toContain('accounts.legacy.poolSize');
  });

  test('guests take no account; every non-guest needs one', () => {
    const d = withAccounts();
    d.personas.guest!.account = 'sales_rep';
    expect(validatePersonas(d).errors.join()).toContain('guest personas are unauthenticated — no account');
    const d2 = withAccounts();
    delete d2.personas.old_timer!.account;
    expect(validatePersonas(d2).errors.join()).toContain('old_timer.account: required');
  });

  test("the account's auth decides the portal/frontdoor rule", () => {
    const d = withAccounts();
    d.accounts!.portal_login = { auth: 'frontdoor' };
    d.personas.portal_user = { kind: 'portal', site: 'portal', account: 'portal_login' };
    expect(validatePersonas(d).errors.join()).toContain('portal_user.auth');
  });

  test('envBlockFor: one paste-ready block per account, roles listed, names only', () => {
    const lines = envBlockFor(withAccounts(), 'sales_mgr');
    expect(lines[0]).toBe('# sales_mgr — salesforce login for: Client Lead, Business Development Manager');
    expect(lines).toContain('SF_SALES_MGR_USERNAME=');
    expect(lines).toContain('SF_SALES_MGR_PASSWORD=');
    expect(lines).toContain('SF_SALES_MGR_TOKEN=');
    expect(lines).toContain('SF_SALES_MGR_TOTP_SECRET=');
    expect(lines.every((l) => l.startsWith('#') || /^[A-Z0-9_]+=$/.test(l))).toBe(true);
    expect(envBlockFor(withAccounts(), 'nope')).toEqual([]);
  });
});

test.describe('PersonaRegistry with accounts', () => {
  const reg = () => PersonaRegistry.fromDoc(withAccounts());

  test('get() returns the effective persona: account wiring, auth and pool filled in', () => {
    const lead = reg().get('client_lead');
    expect(lead.role).toBe('Client Lead');
    expect(lead.usernameEnv).toBe('SF_SALES_MGR_USERNAME');
    expect(lead.totpEnv).toBe('SF_SALES_MGR_TOTP_SECRET');
    expect(lead.auth).toBe('frontdoor');
    expect(lead.poolSize).toBe(2);
    expect(reg().get('siebel_agent').passwordEnv).toBe('SIEBEL_CRM_OPS_PASSWORD');
    expect(reg().get('old_timer').usernameEnv).toBe('OLD_USER');
  });

  test('two roles on one account resolve the same login and share one session file', () => {
    const r = reg();
    expect(r.accountOf('client_lead')).toBe('sales_mgr');
    expect(r.accountOf('bdm')).toBe('sales_mgr');
    expect(r.rolesOf('sales_mgr')).toEqual(['client_lead', 'bdm']);
    const env = { SF_SALES_MGR_USERNAME_W1: 'mgr@x', SF_SALES_MGR_PASSWORD_W1: 'pw' };
    expect(r.resolveCreds('bdm', env, 1)).toEqual({ username: 'mgr@x', password: 'pw', token: undefined });
    expect(r.statePathForPersona('client_lead', 1)).toBe(r.statePathForPersona('bdm', 1));
    expect(r.statePathForPersona('bdm', 1)).toContain('sales_mgr-w1.json');
  });

  test('missingEnvNames speaks in account env names', () => {
    expect(reg().missingEnvNames('client_associate', {})).toEqual(['SF_SALES_REP_TOKEN', 'SF_SALES_REP_USERNAME', 'SF_SALES_REP_PASSWORD']);
    expect(reg().accountIds()).toEqual(['sales_rep', 'sales_mgr', 'crm_ops', 'legacy']);
  });
});

test('personas.schema.json (editor help) agrees with the TypeScript validator on every key', () => {
  // The .json is what editors show on hover; schema.ts is what runs. Keep them one.
   
  const json = require(path.resolve(__dirname, '../../src/personas/personas.schema.json')) as {
    properties: { accounts: { additionalProperties: { properties: Record<string, unknown> } }; personas: { additionalProperties: { properties: Record<string, unknown> } } };
  };
  const accountKeys = Object.keys(json.properties.accounts.additionalProperties.properties).sort();
  const personaKeys = Object.keys(json.properties.personas.additionalProperties.properties).sort();
  // Probe the TS validator: an unknown key is rejected, every listed key is accepted.
  for (const k of accountKeys) {
    const d = withAccounts() as unknown as { accounts: Record<string, Record<string, unknown>> };
    d.accounts.sales_rep![k] = k === 'poolSize' ? 1 : k === 'auth' ? 'ui' : k === 'system' ? 'salesforce' : 'SF_X_NAME';
    expect(validatePersonas(d).errors.filter((e) => e.includes('unknown key')), `accounts.${k}`).toEqual([]);
  }
  for (const k of personaKeys) {
    const d = withAccounts() as unknown as { personas: Record<string, Record<string, unknown>> };
    d.personas.old_timer![k] = k === 'poolSize' ? 1 : k === 'auth' ? 'ui' : k === 'kind' ? 'internal' : k === 'permissionSets' ? [] : k === 'site' ? 'portal' : k === 'account' ? 'sales_rep' : 'SF_X_NAME';
    expect(validatePersonas(d).errors.filter((e) => e.includes('unknown key')), `personas.${k}`).toEqual([]);
  }
  const bad = withAccounts() as unknown as { accounts: Record<string, Record<string, unknown>>; personas: Record<string, Record<string, unknown>> };
  bad.accounts.sales_rep!.nickname = 'x';
  bad.personas.client_lead!.nickname = 'x';
  expect(validatePersonas(bad).errors.filter((e) => e.includes('unknown key'))).toHaveLength(2);
  // The repo file declares this schema:
  const repo = require(path.resolve(__dirname, '../../personas.json')) as { $schema: string };
  expect(repo.$schema).toBe('./src/personas/personas.schema.json');
});
