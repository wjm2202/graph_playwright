/**
 * S11 — the dev server's persona-wiring endpoint, tested against a REAL
 * spawned server on a throwaway PLANNER_ROOT: valid renames land in
 * personas.json (names only — .env untouched), bad names are refused with
 * the reason, and /__envstatus reads presence from the sandbox .env.
 */
import { test, expect } from '@playwright/test';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const FIXTURE = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: { siebel: { urlEnv: 'SIEBEL_URL' } },
  personas: {
    sales_user: { kind: 'internal', usernameEnv: 'SF_SALES_USERNAME', passwordEnv: 'SF_SALES_PASSWORD' },
    siebel_admin: { kind: 'internal', site: 'siebel', usernameEnv: 'SIEBEL_ADMIN_USERNAME', passwordEnv: 'SIEBEL_ADMIN_PASSWORD' },
    guest: { kind: 'guest' },
  },
};

let child: ChildProcess;
let base = '';
let tmp = '';

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-root-'));
  fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify(FIXTURE, null, 2));
  fs.writeFileSync(path.join(tmp, '.env'), 'SF_INSTANCE_URL=https://uat.example.com\nSFDC_UAT_USERNAME=me@x\n');

  // Presence must come from the SANDBOX .env alone. The server also honors
  // real process.env (a feature in production), and playwright.config.ts
  // dotenv-loads the repo .env into THIS process — so a developer's .env
  // would leak through an inherited environment and flip the booleans below.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(SF_|SFDC_|SIEBEL_)/.test(k)),
  );
  child = spawn('node', [path.resolve('tools/serve-planner.mjs')], {
    env: { ...cleanEnv, PLANNER_ROOT: tmp, PLANNER_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('server never announced its port')); }, 15_000);
    child.stdout!.on('data', (buf: Buffer) => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(String(buf));
      if (m) { clearTimeout(timer); resolve(`http://127.0.0.1:${m[1]}`); }
    });
    child.on('exit', (code) => { reject(new Error(`server exited early (${code})`)); });
  });
});

test.afterAll(() => {
  child?.kill();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const personas = () => JSON.parse(fs.readFileSync(path.join(tmp, 'personas.json'), 'utf8'));
const post = (body: unknown) =>
  fetch(`${base}/__personas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('envstatus: presence booleans from the root .env — never values', async () => {
  const j = await (await fetch(`${base}/__envstatus`)).json();
  expect(j.SF_INSTANCE_URL).toBe(true);
  expect(j.SF_SALES_USERNAME).toBe(false);
  expect(JSON.stringify(j)).not.toContain('uat.example.com'); // presence only
});

test('remap to the team\'s existing .env names — written to personas.json, dots recomputed', async () => {
  const r = await post({ personaId: 'sales_user', usernameEnv: 'SFDC_UAT_USERNAME', totpEnv: 'SFDC_UAT_TOTP_SECRET' });
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.ok).toBe(true);
  expect(j.wiring).toMatchObject({ username: 'SFDC_UAT_USERNAME', totp: 'SFDC_UAT_TOTP_SECRET', url: 'SF_INSTANCE_URL' });
  expect(j.envstatus.SFDC_UAT_USERNAME).toBe(true); // exists in the team .env

  const doc = personas();
  expect(doc.personas.sales_user.usernameEnv).toBe('SFDC_UAT_USERNAME');
  expect(doc.personas.sales_user.totpEnv).toBe('SFDC_UAT_TOTP_SECRET');
  expect(doc.personas.sales_user.passwordEnv).toBe('SF_SALES_PASSWORD'); // untouched
});

test('site personas route urlEnv to their site; org personas to the org', async () => {
  const r = await post({ personaId: 'siebel_admin', urlEnv: 'SIEBEL_UAT_URL' });
  expect(r.status).toBe(200);
  expect(personas().sites.siebel.urlEnv).toBe('SIEBEL_UAT_URL');
  expect(personas().org.instanceUrlEnv).toBe('SF_INSTANCE_URL'); // org untouched
});

test('a system that does not use a credential: clearing removes the mapping; losing the last secret warns', async () => {
  // totp cleared → key gone, no warning (password remains):
  let r = await post({ personaId: 'sales_user', totpEnv: '' });
  expect(r.status).toBe(200);
  let j = await r.json();
  expect(j.wiring.totp).toBeUndefined();
  expect(j.warning).toBeUndefined();
  expect('totpEnv' in personas().personas.sales_user).toBe(false);

  // password cleared with no token left → allowed, but WARNS:
  r = await post({ personaId: 'sales_user', passwordEnv: '' });
  expect(r.status).toBe(200);
  j = await r.json();
  expect(j.warning).toContain('cannot authenticate until one is wired');
  expect('passwordEnv' in personas().personas.sales_user).toBe(false);

  // re-wire for the tests that follow:
  await post({ personaId: 'sales_user', passwordEnv: 'SF_SALES_PASSWORD' });
});

test('projects: GET lists the sandbox registry; POST scaffolds a team-named project; bad names 400', async () => {
  let j = await (await fetch(`${base}/__projects`)).json();
  expect(j.projects).toEqual([]); // fresh sandbox root — nothing hardcoded anywhere

  const make = await fetch(`${base}/__projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'web_shop', team: 'Web' }),
  });
  expect(make.status).toBe(200);
  j = await make.json();
  expect(j.ok).toBe(true);
  expect(j.project).toMatchObject({ project: 'web_shop', team: 'Web', namePrefix: 'E2E_WEB_SHOP' });
  expect(j.projects.map((p: { project: string }) => p.project)).toEqual(['web_shop']);
  expect(fs.existsSync(path.join(tmp, 'projects', 'web_shop', 'graphs'))).toBe(true);
  expect(fs.existsSync(path.join(tmp, 'projects', 'web_shop', 'project.json'))).toBe(true);

  const bad = await fetch(`${base}/__projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'Bad Name' }),
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain('lower-case');

  const dup = await fetch(`${base}/__projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'web_shop' }),
  });
  expect(dup.status).toBe(400);
  expect((await dup.json()).error).toContain('already exists');

  j = await (await fetch(`${base}/__projects`)).json();
  expect(j.projects.length).toBe(1);
});

test('refusals: pasted secrets, empty username, unknown/guest personas — file never changes', async () => {
  const before = JSON.stringify(personas());

  const secret = await post({ personaId: 'sales_user', totpEnv: 'JBSWY3DPEHPK3PXP' });
  expect(secret.status).toBe(400);
  expect((await secret.json()).error).toContain('looks like a pasted secret');

  const empty = await post({ personaId: 'sales_user', usernameEnv: '' });
  expect(empty.status).toBe(400);
  expect((await empty.json()).error).toContain('usernameEnv is required');

  expect((await post({ personaId: 'ghost' })).status).toBe(404);
  expect((await post({ personaId: 'guest', usernameEnv: 'X_USER' })).status).toBe(400);

  expect(JSON.stringify(personas())).toBe(before);
});
