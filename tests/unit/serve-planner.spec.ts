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
    env: { ...cleanEnv, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1' },
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

test('imports: POST stores + parses into the project, GET lists, apply writes graphs and refuses repeats', async () => {
  // The project from the test above ('web_shop') exists in the sandbox root;
  // create a dedicated one so ordering between tests never matters.
  const mk = await fetch(`${base}/__projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'crm_imports', team: 'CRM' }),
  });
  expect(mk.status).toBe(200);

  const csv =
    'ID,Work Item Type,Title,Steps\n' +
    '11,Test Case,Create customer,"1. As admin, create a new customer | Customer record is created"\n' +
    '12,Test Case,Add address,"1. Add a new address to existing customer | Address saved"\n';
  const up = await fetch(`${base}/__imports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'crm_imports', filename: 'plan.csv', contentBase64: Buffer.from(csv).toString('base64') }),
  });
  expect(up.status).toBe(200);
  const stored = await up.json();
  expect(stored.ok).toBe(true);
  expect(stored.import.cases.map((c: { title: string }) => c.title)).toEqual(['Create customer', 'Add address']);
  expect(fs.existsSync(path.join(tmp, 'projects', 'crm_imports', 'imports', stored.import.file))).toBe(true);

  const list = await (await fetch(`${base}/__imports?project=crm_imports`)).json();
  expect(list.imports.map((m: { id: string }) => m.id)).toEqual([stored.import.id]);

  const apply = await fetch(`${base}/__imports/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'crm_imports', importId: stored.import.id, indexes: [1] }),
  });
  expect(apply.status).toBe(200);
  const applied = await apply.json();
  expect(applied.results.map((r: { graphId: string }) => r.graphId)).toEqual(['add_address']);
  expect(fs.existsSync(path.join(tmp, 'projects', 'crm_imports', 'graphs', 'add_address.graph.json'))).toBe(true);
  expect(applied.import.cases[1].graphId).toBe('add_address');
  expect(applied.import.cases[0].graphId).toBeUndefined();

  const again = await fetch(`${base}/__imports/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'crm_imports', importId: stored.import.id, indexes: [1] }),
  });
  expect(again.status).toBe(400);
  expect((await again.json()).error).toContain('already imported');

  const nothing = await fetch(`${base}/__imports/apply`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'crm_imports', importId: stored.import.id, indexes: [] }),
  });
  expect((await nothing.json()).error).toContain('pick at least one');

  const badProject = await fetch(`${base}/__imports`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'ghost', filename: 'plan.csv', contentBase64: Buffer.from(csv).toString('base64') }),
  });
  expect(badProject.status).toBe(400);
  expect((await badProject.json()).error).toContain("project 'ghost' does not exist");
});

test('graphs: POST saves a valid graph into the project (atomic), 409s on an existing file until overwrite, 400s otherwise', async () => {
  await fetch(`${base}/__projects`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: 'saves' }),
  });
  const graph = {
    schema: 'process-graph/2', id: 'tiny', systems: { sf: { label: 'Salesforce', kind: 'salesforce' } }, actors: { a: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess', type: 'session', label: 'SF · a', system: 'sf', actor: 'a' },
      { id: 'rec', type: 'data', label: 'Record', sobject: 'Account' },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'l', from: 'start', to: 'sess', type: 'login_as' },
      { id: 'd', from: 'sess', to: 'rec', type: 'does', data: { catalog: 'rec.create', io: 'produces' } },
      { id: 'n', from: 'rec', to: 'end', type: 'next' },
    ],
  };
  const post = (body: unknown) => fetch(`${base}/__graphs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const first = await post({ project: 'saves', graph });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ ok: true, ref: 'saves/tiny', file: 'projects/saves/graphs/tiny.graph.json', overwritten: false });
  const file = path.join(tmp, 'projects', 'saves', 'graphs', 'tiny.graph.json');
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(graph);
  expect(fs.readdirSync(path.dirname(file)).filter((f) => f.endsWith('.tmp'))).toEqual([]); // atomic: no temp left

  const again = await post({ project: 'saves', graph: { ...graph, title: 'v2' } });
  expect(again.status).toBe(409);
  expect(await again.json()).toMatchObject({ ok: false, exists: true });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).title).toBeUndefined(); // untouched

  const over = await post({ project: 'saves', graph: { ...graph, title: 'v2' }, overwrite: true });
  expect(await over.json()).toMatchObject({ ok: true, overwritten: true });
  expect(JSON.parse(fs.readFileSync(file, 'utf8')).title).toBe('v2');

  const invalid = await post({ project: 'saves', graph: { ...graph, nodes: graph.nodes.slice(1) } });
  expect(invalid.status).toBe(400);
  expect((await invalid.json()).error).toContain('graph invalid');
  const ghost = await post({ project: 'ghost', graph });
  expect((await ghost.json()).error).toContain("project 'ghost' does not exist");
  const bad = await post({ project: 'Bad', graph });
  expect((await bad.json()).error).toContain('lower-case');
});
