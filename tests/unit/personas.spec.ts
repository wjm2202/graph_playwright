/**
 * personas.json schema + registry: the no-secrets-in-JSON contract, pool
 * suffixing, legacy env fallback, and actionable failure messages.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { accountEnvNames, envBlockFor, envPrefixFor, validatePersonas, type PersonasDoc } from '../../src/personas/schema';
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

  test('non-guest persona without an account or usernameEnv is rejected', () => {
    const d = good();
    delete (d.personas.admin as Record<string, unknown>).usernameEnv;
    const r = validatePersonas(d);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('admin.account: required');
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
    self_wired: { kind: 'internal', usernameEnv: 'SF_SELF_USERNAME', passwordEnv: 'SF_SELF_PASSWORD' },
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

  test('account AND own *Env wiring on one persona is rejected', () => {
    const d = withAccounts();
    d.personas.client_lead!.usernameEnv = 'SF_X_USERNAME';
    expect(validatePersonas(d).errors.join()).toContain('the account owns the wiring');
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

  test('guests take no account; non-guests need an account or legacy usernameEnv', () => {
    const d = withAccounts();
    d.personas.guest!.account = 'sales_rep';
    expect(validatePersonas(d).errors.join()).toContain('guest personas are unauthenticated — no account');
    const d2 = withAccounts();
    delete d2.personas.self_wired!.usernameEnv;
    expect(validatePersonas(d2).errors.join()).toContain('self_wired.account: required');
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
    expect(reg().get('self_wired').usernameEnv).toBe('SF_SELF_USERNAME');
  });

  test('two roles on one account resolve the same login and share one session file', () => {
    const r = reg();
    expect(r.accountOf('client_lead')).toBe('sales_mgr');
    expect(r.accountOf('bdm')).toBe('sales_mgr');
    expect(r.accountOf('self_wired')).toBe('self_wired');
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
    d.personas.self_wired![k] = k === 'poolSize' ? 1 : k === 'auth' ? 'ui' : k === 'kind' ? 'internal' : k === 'permissionSets' ? [] : k === 'site' ? 'portal' : k === 'account' ? 'sales_rep' : 'SF_X_NAME';
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
