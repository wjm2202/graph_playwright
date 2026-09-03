/**
 * S2.3 — the persona wiring rules, tested where they now live (src/personas/
 * wiring.ts) instead of only through the dev server: one slug for the repo,
 * roles → logins, renames that land on the login, and `.env` presence read by
 * dotenv itself.
 */
import { test, expect } from '@playwright/test';
import { adoCaseToGraph } from '../../src/graph/fromAdo';
import { accountEnvNames, effectivePersona, validatePersonas, type PersonasDoc } from '../../src/personas/schema';
import { addPersonas, envNameError, envPresence, renameEnvName, slugRole } from '../../src/personas/wiring';

const roster = (): PersonasDoc => ({
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  accounts: {
    sales_mgr: { auth: 'frontdoor' },
    other_org: { usernameEnv: 'SF_LEGACY_USERNAME', passwordEnv: 'SF_LEGACY_PASSWORD' },
  },
  personas: {
    client_lead: { kind: 'internal', role: 'Client Lead', account: 'sales_mgr' },
    bdm: { kind: 'internal', role: 'Business Development Manager', account: 'sales_mgr' },
    other_user: { kind: 'internal', role: 'Other', account: 'other_org' },
    guest: { kind: 'guest' },
  },
});

test.describe('slugRole — ONE slug for the repo', () => {
  test('a role typed into the planner lands on the id the ADO import would mint', () => {
    const roles = [
      'Client Associate',
      'Business Development Manager',
      'Credit and Collections',
      'Client Lead (SIT)',
      'Senior Regional Customer Operations Specialist Manager', // past the 40-char cut
    ];
    for (const role of roles) {
      // fromAdo names the actor alias from the same role text — read-only here.
      const { graph } = adoCaseToGraph({ title: 'parity', steps: [{ action: `As ${role}: open the record` }] });
      expect(Object.keys(graph.actors), `alias for '${role}'`).toEqual([slugRole(role)]);
    }
  });

  test('truncation never leaves a trailing underscore, and punctuation collapses', () => {
    expect(slugRole('Credit & Collections')).toBe('credit_collections');
    expect(slugRole('  Client   Lead  ')).toBe('client_lead');
    const long = slugRole('Senior Regional Customer Operations Specialist');
    expect(long.length).toBeLessThanOrEqual(40);
    expect(long.endsWith('_')).toBe(false);
  });
});

test.describe('envNameError', () => {
  test('accepts names, refuses values', () => {
    expect(envNameError('SFDC_UAT_USERNAME')).toBeNull();
    expect(envNameError('sfdc_uat_username')).toContain('ENV VAR NAME');
    expect(envNameError('JBSWY3DPEHPK3PXP')).toContain('looks like a pasted secret');
    expect(envNameError(`SF_${'X'.repeat(70)}`)).toContain('too long');
  });
});

test.describe('addPersonas', () => {
  test('a new role gets a login named after it; two roles can share one', () => {
    const r = addPersonas(roster(), [
      { role: 'Client Associate' },
      { role: 'Billing Clerk', account: 'shared_ops' },
      { role: 'Collections Clerk', account: 'shared_ops' },
    ]);
    expect(r.created.added).toEqual(['client_associate', 'billing_clerk', 'collections_clerk']);
    expect(r.created.bound).toEqual({ client_associate: 'client_associate', billing_clerk: 'shared_ops', collections_clerk: 'shared_ops' });
    expect(r.created.accountsCreated).toEqual(['client_associate', 'shared_ops']);
    expect(r.roster.personas.billing_clerk).toEqual({ kind: 'internal', role: 'Billing Clerk', account: 'shared_ops' });
    expect(validatePersonas(r.roster).errors).toEqual([]);

    // One env block per LOGIN, naming every role that plays it:
    expect(Object.keys(r.envBlock)).toEqual(['client_associate', 'shared_ops']);
    expect(r.envBlock.shared_ops).toEqual([
      '# shared_ops — salesforce login for: Billing Clerk, Collections Clerk',
      'SF_SHARED_OPS_USERNAME=', 'SF_SHARED_OPS_PASSWORD=',
      '# optional: token (preferred over password when set), TOTP secret (only under MFA)',
      'SF_SHARED_OPS_TOKEN=', 'SF_SHARED_OPS_TOTP_SECRET=',
    ]);
  });

  test('a role already on the roster is reported, not rewritten (save calls this every time)', () => {
    const before = roster();
    const r = addPersonas(before, [{ role: 'Client Lead' }, { role: 'Business Admin', account: 'sales_mgr' }]);
    expect(r.created.existing).toEqual(['client_lead']);
    expect(r.created.added).toEqual(['business_admin']);
    expect(r.created.accountsCreated).toEqual([]); // sales_mgr already declared
    expect(r.envBlock).toEqual({});
    expect(r.roster.personas.client_lead).toEqual(before.personas.client_lead);
    expect(before.personas.business_admin).toBeUndefined(); // the input is never mutated
  });

  test('refuses what would become a bad login', () => {
    expect(() => addPersonas(roster(), [{ role: '!!!' }])).toThrow(/does not yield a usable persona id/);
    expect(() => addPersonas(roster(), [{ role: 'Auditor', account: 'Sales Mgr' }])).toThrow(/must be lower_snake_case/);
  });
});

test.describe('renameEnvName', () => {
  test('the rename lands on the LOGIN — every role playing it follows', () => {
    const doc = renameEnvName(roster(), 'sales_mgr', 'username', 'SFDC_UAT_MGR_USER');
    expect(doc.accounts?.sales_mgr).toEqual({ auth: 'frontdoor', usernameEnv: 'SFDC_UAT_MGR_USER' });
    expect(effectivePersona(doc, 'client_lead')?.usernameEnv).toBe('SFDC_UAT_MGR_USER');
    expect(effectivePersona(doc, 'bdm')?.usernameEnv).toBe('SFDC_UAT_MGR_USER');
    expect(doc.personas.client_lead).toEqual(roster().personas.client_lead); // no wiring on the role
    expect(validatePersonas(doc).errors).toEqual([]);
  });

  test("clearing an optional credential says 'this login does not use it'; the username cannot go", () => {
    const doc = renameEnvName(roster(), 'sales_mgr', 'token', '');
    expect(doc.accounts?.sales_mgr?.tokenEnv).toBe('');
    expect(accountEnvNames('sales_mgr', doc.accounts!.sales_mgr).token).toBe(''); // ! — asserted above
    expect(() => renameEnvName(roster(), 'sales_mgr', 'username', '  ')).toThrow(/usernameEnv is required/);
  });

  test('an account overriding the convention keeps its own names; clearing switches one off', () => {
    const doc = renameEnvName(roster(), 'other_org', 'password', '');
    expect(doc.accounts?.other_org?.passwordEnv).toBe('');
    expect(renameEnvName(doc, 'other_org', 'username', 'SFDC_UAT_USERNAME').accounts?.other_org?.usernameEnv)
      .toBe('SFDC_UAT_USERNAME');
  });

  test('refuses values, unknown logins, and a name another login already owns', () => {
    expect(() => renameEnvName(roster(), 'sales_mgr', 'totp', 'JBSWY3DPEHPK3PXP')).toThrow(/totpEnv: looks like a pasted secret/);
    expect(() => renameEnvName(roster(), 'sales_mgr', 'username', 'lower_case')).toThrow(/usernameEnv: must be an ENV VAR NAME/);
    expect(() => renameEnvName(roster(), 'ghost', 'username', 'SF_X_USERNAME')).toThrow(/not declared in personas.json/);
    // SF_LEGACY_USERNAME is other_org's — two logins must not share one.
    expect(() => renameEnvName(roster(), 'sales_mgr', 'username', 'SF_LEGACY_USERNAME')).toThrow(/already the username name of login 'other_org'/);
    // Re-stating a login's own name is a no-op, not a clash:
    expect(renameEnvName(roster(), 'other_org', 'username', 'SF_LEGACY_USERNAME').accounts?.other_org?.usernameEnv)
      .toBe('SF_LEGACY_USERNAME');
  });
});

test.describe('envPresence', () => {
  const ENV = [
    '# a comment about the org',
    'SF_INSTANCE_URL=https://uat.example.com',
    'export SF_SALES_USERNAME=me@example.com   # trailing note',
    'SF_SALES_PASSWORD="quoted secret"',
    "SF_SALES_TOKEN='single quoted'",
    'SF_SALES_TOTP_SECRET=',
    '  SF_SPACED  =  x  ',
    '#SF_COMMENTED=value',
  ].join('\n');

  test('set/unset only — comments, quotes and export lines read as dotenv reads them', () => {
    expect(envPresence(ENV, [
      'SF_INSTANCE_URL', 'SF_SALES_USERNAME', 'SF_SALES_PASSWORD', 'SF_SALES_TOKEN',
      'SF_SALES_TOTP_SECRET', 'SF_SPACED', 'SF_COMMENTED', 'SF_ABSENT',
    ])).toEqual({
      SF_INSTANCE_URL: true,
      SF_SALES_USERNAME: true,   // `export NAME=` is a real assignment
      SF_SALES_PASSWORD: true,
      SF_SALES_TOKEN: true,
      SF_SALES_TOTP_SECRET: false, // present but empty = not filled in yet
      SF_SPACED: true,
      SF_COMMENTED: false,
      SF_ABSENT: false,
    });
  });

  test('no values escape, and an empty file answers every name', () => {
    expect(JSON.stringify(envPresence(ENV, ['SF_INSTANCE_URL']))).not.toContain('uat.example.com');
    expect(envPresence('', ['SF_INSTANCE_URL'])).toEqual({ SF_INSTANCE_URL: false });
  });
});
