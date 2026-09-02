/**
 * S3 — env doctor: graph → the exact .env lines between you and a runnable
 * graph. Diagnosis is pure (fake env in, report out) — nothing is written.
 */
import { test, expect } from '@playwright/test';
import { envDoctor, formatDoctorReport } from '../../src/personas/doctor';
import { PersonaRegistry } from '../../src/personas/registry';
import { goodGraphV2 } from '../helpers/sampleGraph';
import type { ProcessGraph } from '../../src/graph/schema';

const registry = () =>
  PersonaRegistry.fromDoc({
    org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
    sites: { siebel: { urlEnv: 'SIEBEL_URL' } },
    personas: {
      sales_user: { kind: 'internal', usernameEnv: 'SF_SALES_USERNAME', passwordEnv: 'SF_SALES_PASSWORD' },
      admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME', passwordEnv: 'SF_ADMIN_PASSWORD', tokenEnv: 'SF_ADMIN_TOKEN' },
      siebel_admin: { kind: 'internal', site: 'siebel', usernameEnv: 'SIEBEL_ADMIN_USERNAME', passwordEnv: 'SIEBEL_ADMIN_PASSWORD' },
      portal_user: { kind: 'guest' },
    },
  });

test('bare env: every gap is named, with a copy-paste .env skeleton', () => {
  const r = envDoctor(goodGraphV2(), registry(), {});
  expect(r.ready).toBe(false);
  expect(r.org).toEqual({ env: 'SF_INSTANCE_URL', set: false });

  const byAlias = Object.fromEntries(r.personas.map((p) => [p.alias, p]));
  expect(byAlias.submitter!.missing).toEqual(['SF_SALES_USERNAME', 'SF_SALES_PASSWORD']);
  expect(byAlias.approver!.missing).toEqual(['SF_ADMIN_TOKEN', 'SF_ADMIN_USERNAME', 'SF_ADMIN_PASSWORD']);

  expect(r.envLines[0]).toBe('SF_INSTANCE_URL=');
  expect(r.envLines).toContain('SF_SALES_USERNAME=');

  const text = formatDoctorReport(r);
  expect(text).toContain("graph 'expense_to_siebel' — not runnable yet");
  expect(text).toContain('add to .env');
});

test('full env: READY, no lines to add — token alone satisfies a persona', () => {
  const env = {
    SF_INSTANCE_URL: 'https://uat.my.salesforce.com',
    SF_SALES_USERNAME: 'u', SF_SALES_PASSWORD: 'p',
    SF_ADMIN_TOKEN: 'tok', // no admin user/pass needed
    // The Siebel session is its own persona on its own system — "full" env
    // for this graph means Siebel creds too.
    SIEBEL_URL: 'https://siebel.example.test',
    SIEBEL_ADMIN_USERNAME: 'su', SIEBEL_ADMIN_PASSWORD: 'sp',
  };
  const r = envDoctor(goodGraphV2(), registry(), env);
  expect(r.ready).toBe(true);
  expect(r.envLines).toEqual([]);
  expect(formatDoctorReport(r)).toContain('READY to run');
});

test('site-bound personas surface their site URL env (Siebel)', () => {
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'siebel_check', systems: { siebel: { label: 'Siebel', kind: 'siebel' } },
    actors: { verifier: 'siebel_admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 's', type: 'session', label: 'Siebel · verifier', system: 'siebel', actor: 'verifier' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 's', type: 'login_as' },
      { id: 'e2', from: 's', to: 'end', type: 'next' },
    ],
  };
  const r = envDoctor(g, registry(), { SF_INSTANCE_URL: 'x' });
  expect(r.sites).toEqual([{ site: 'siebel', env: 'SIEBEL_URL', set: false }]);
  expect(r.envLines).toContain('SIEBEL_URL=');
  expect(r.personas[0]!.missing).toEqual(['SIEBEL_ADMIN_USERNAME', 'SIEBEL_ADMIN_PASSWORD']);
  expect(r.ready).toBe(false);
});

test('an actor bound to an unknown persona is a named failure, not a crash', () => {
  const g = goodGraphV2();
  g.actors.submitter = 'ghost_user';
  const r = envDoctor(g, registry(), { SF_INSTANCE_URL: 'x' });
  expect(r.ready).toBe(false);
  const ghost = r.personas.find((p) => p.personaId === 'ghost_user')!;
  expect(ghost.known).toBe(false);
  expect(formatDoctorReport(r)).toContain("NOT in personas.json");
});

test('totp secrets are informational — noted when declared but unset, never blocking', () => {
  const r = PersonaRegistry.fromDoc({
    org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
    personas: {
      sales_user: {
        kind: 'internal',
        usernameEnv: 'SF_SALES_USERNAME', passwordEnv: 'SF_SALES_PASSWORD', totpEnv: 'SF_SALES_TOTP_SECRET',
      },
    },
  });
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'g', systems: { sf: { label: 'SF', kind: 'salesforce' } },
    actors: { u: 'sales_user' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 's', type: 'session', label: 'SF · u', system: 'sf', actor: 'u' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 's', type: 'login_as' },
      { id: 'e2', from: 's', to: 'end', type: 'next' },
    ],
  };
  const env = { SF_INSTANCE_URL: 'x', SF_SALES_USERNAME: 'u', SF_SALES_PASSWORD: 'p' };
  const report = envDoctor(g, r, env);
  expect(report.ready).toBe(true); // totp absence never blocks
  expect(formatDoctorReport(report)).toContain('totp SF_SALES_TOTP_SECRET unset — needed only if MFA is enforced');

  const withTotp = envDoctor(g, r, { ...env, SF_SALES_TOTP_SECRET: 'JB...' });
  expect(formatDoctorReport(withTotp)).not.toContain('totp');
});

test('guest personas are always ready (no creds by design)', () => {
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'g', systems: { app: { label: 'A', kind: 'web' } },
    actors: { visitor: 'portal_user' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 's', type: 'session', label: 'A · visitor', system: 'app', actor: 'visitor' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 's', type: 'login_as' },
      { id: 'e2', from: 's', to: 'end', type: 'next' },
    ],
  };
  const r = envDoctor(g, registry(), { SF_INSTANCE_URL: 'x' });
  expect(r.ready).toBe(true);
});

test('roles sharing one account are reported as ONE login to fix', () => {
  const reg = PersonaRegistry.fromDoc({
    org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
    accounts: { sales_mgr: { auth: 'frontdoor' }, sales_rep: {} },
    personas: {
      client_lead: { kind: 'internal', role: 'Client Lead', account: 'sales_mgr' },
      bdm: { kind: 'internal', role: 'BDM', account: 'sales_mgr' },
      client_associate: { kind: 'internal', role: 'Client Associate', account: 'sales_rep' },
    },
  });
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'l2c', systems: { sf: { label: 'SF', kind: 'salesforce' } },
    actors: { creator: 'client_associate', lead: 'client_lead', manager: 'bdm' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 's1', type: 'session', label: 'SF · creator', system: 'sf', actor: 'creator' },
      { id: 's2', type: 'session', label: 'SF · lead', system: 'sf', actor: 'lead' },
      { id: 's3', type: 'session', label: 'SF · manager', system: 'sf', actor: 'manager' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 's1', type: 'login_as' },
      { id: 'e2', from: 's1', to: 's2', type: 'login_as' },
      { id: 'e3', from: 's2', to: 's3', type: 'login_as' },
      { id: 'e4', from: 's3', to: 'end', type: 'next' },
    ],
  };
  const env = { SF_INSTANCE_URL: 'x', SF_SALES_REP_USERNAME: 'u', SF_SALES_REP_PASSWORD: 'p' };
  const r = envDoctor(g, reg, env);
  expect(r.ready).toBe(false);
  expect(r.personas.map((p) => [p.alias, p.account])).toEqual([['creator', 'sales_rep'], ['lead', 'sales_mgr'], ['manager', 'sales_mgr']]);
  expect(r.accounts).toEqual([
    { account: 'sales_rep', roles: ['client_associate'], ready: true, missing: [] },
    { account: 'sales_mgr', roles: ['client_lead', 'bdm'], ready: false, missing: ['SF_SALES_MGR_TOKEN', 'SF_SALES_MGR_USERNAME', 'SF_SALES_MGR_PASSWORD'] },
  ]);
  // The .env skeleton names the shared login ONCE, not once per role:
  expect(r.envLines.filter((l) => l === 'SF_SALES_MGR_USERNAME=')).toHaveLength(1);
  const text = formatDoctorReport(r);
  expect(text).toContain('role     ✗ lead → client_lead (login: sales_mgr)');
  expect(text).toContain('login    ✗ sales_mgr plays client_lead, bdm — set SF_SALES_MGR_TOKEN or SF_SALES_MGR_USERNAME or SF_SALES_MGR_PASSWORD');
  expect(text).toContain('login    ✓ sales_rep plays client_associate');
});
