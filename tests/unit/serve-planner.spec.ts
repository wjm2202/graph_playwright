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
/** The server's own stdout — the observable for "did this rebuild?". */
let log = '';

test.beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-root-'));
  fs.writeFileSync(path.join(tmp, 'personas.json'), JSON.stringify(FIXTURE, null, 2));
  fs.writeFileSync(path.join(tmp, '.env'), 'SF_INSTANCE_URL=https://uat.example.com\nSFDC_UAT_USERNAME=me@x\n');
  // A recording that never opens a browser: PLANNER_RECORD_CMD stands in for
  // `npm run record`, and 'hold_flow' stays alive so a second request 409s.
  fs.writeFileSync(path.join(tmp, 'fake-record.mjs'),
    "console.log('▶ RECORDING ' + process.env.RECORD_JOURNEY + ' as ' + process.env.RECORD_PERSONA);\n" +
    "if (process.env.RECORD_JOURNEY === 'hold_flow') setTimeout(() => process.exit(0), 5000);\n");

  // Presence must come from the SANDBOX .env alone. The server also honors
  // real process.env (a feature in production), and playwright.config.ts
  // dotenv-loads the repo .env into THIS process — so a developer's .env
  // would leak through an inherited environment and flip the booleans below.
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(SF_|SFDC_|SIEBEL_)/.test(k)),
  );
  child = spawn('node', [path.resolve('tools/serve-planner.mjs')], {
    env: {
      ...cleanEnv, PLANNER_ROOT: tmp, PLANNER_PORT: '0', PLANNER_NO_REBUILD: '1',
      PLANNER_RECORD_CMD: `node ${path.join(tmp, 'fake-record.mjs')}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('server never announced its port')); }, 15_000);
    child.stdout!.on('data', (buf: Buffer) => {
      log += String(buf);
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

test('capabilities: the page can tell a current server from a stale one', async () => {
  const j = await (await fetch(`${base}/__capabilities`)).json();
  expect(j).toEqual({ version: 6, imports: true, graphs: true, projects: true, personas: true, accounts: true, library: true, record: true, recordings: true });
});

test('the served page carries a live-reload snippet that defers to window.plannerHoldReload', async () => {
  const html = await (await fetch(`${base}/`)).text();
  expect(html).toContain('window.__plannerReload=function()');
  expect(html).toContain('plannerHoldReload');
  expect(html).toContain('__plannerReloadPending=true');
});

test('personas: GET lists roster + accounts; POST /__personas/add binds each role to an account (new or chosen), appends ONE .env block per new login', async () => {
  fs.writeFileSync(path.join(tmp, '.env.example'), 'SF_INSTANCE_URL=\n');
  let j = await (await fetch(`${base}/__personas`)).json();
  expect(j.roster.map((p: { id: string }) => p.id)).toEqual(['sales_user', 'siebel_admin', 'guest']);
  expect(j.roster[0].account).toBe('sales_user'); // legacy self-wired persona = its own login
  expect(j.accounts).toEqual([]);

  const add = await fetch(`${base}/__personas/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      roles: ['Client Associate', 'Client Lead', 'Business Development Manager', 'sales_user'],
      // the lead and the BDM are the same sandbox login; the associate gets its own
      accounts: { 'Client Lead': 'sales_mgr', 'Business Development Manager': 'sales_mgr' },
    }),
  });
  expect(add.status).toBe(200);
  j = await add.json();
  expect(j.added).toEqual(['client_associate', 'client_lead', 'business_development_manager']);
  expect(j.existing).toEqual(['sales_user']);
  expect(j.bound).toEqual({ client_associate: 'client_associate', client_lead: 'sales_mgr', business_development_manager: 'sales_mgr' });
  expect(j.accountsCreated).toEqual(['client_associate', 'sales_mgr']);
  expect(j.envBlocks.sales_mgr).toEqual([
    '# sales_mgr — salesforce login for: Client Lead, Business Development Manager',
    'SF_SALES_MGR_USERNAME=', 'SF_SALES_MGR_PASSWORD=',
    '# optional: token (preferred over password when set), TOTP secret (only under MFA)',
    'SF_SALES_MGR_TOKEN=', 'SF_SALES_MGR_TOTP_SECRET=',
  ]);
  expect(j.accounts.map((a: { id: string; roles: string[] }) => [a.id, a.roles])).toEqual([
    ['client_associate', ['client_associate']], ['sales_mgr', ['client_lead', 'business_development_manager']],
  ]);
  const doc = personas();
  expect(doc.personas.client_lead).toEqual({ kind: 'internal', role: 'Client Lead', account: 'sales_mgr' });
  expect(doc.accounts.sales_mgr).toEqual({ auth: 'frontdoor' });
  expect(doc.personas.sales_user.usernameEnv).toBe('SF_SALES_USERNAME'); // untouched
  const example = fs.readFileSync(path.join(tmp, '.env.example'), 'utf8');
  expect(example).toContain('SF_CLIENT_ASSOCIATE_USERNAME=');
  expect(example.match(/SF_SALES_MGR_USERNAME=/g)).toHaveLength(1); // one block per LOGIN, not per role
  expect(example).not.toContain('SF_CLIENT_LEAD_USERNAME');
  expect(fs.readdirSync(tmp).filter((f) => f.endsWith('.tmp'))).toEqual([]);

  // Binding a later role to an EXISTING account creates no account and no env block:
  const more = await (await fetch(`${base}/__personas/add`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ roles: ['Business Admin'], accounts: { 'Business Admin': 'sales_mgr' } }),
  })).json();
  expect(more.accountsCreated).toEqual([]);
  expect(more.envBlocks).toEqual({});
  expect(personas().personas.business_admin.account).toBe('sales_mgr');
  expect(fs.readFileSync(path.join(tmp, '.env.example'), 'utf8').match(/SF_SALES_MGR_USERNAME=/g)).toHaveLength(1);

  const bad = await fetch(`${base}/__personas/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: ['!!!'] }) });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toContain('does not yield a usable persona id');
  const badAcct = await fetch(`${base}/__personas/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: ['Auditor'], accounts: { Auditor: 'Sales Mgr' } }) });
  expect((await badAcct.json()).error).toContain('must be lower_snake_case');
  const none = await fetch(`${base}/__personas/add`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roles: [] }) });
  expect((await none.json()).error).toContain('at least one role');
});

// ── S2.3: the library is READ, not rebuilt; recordings are spawned ───────

/** A valid two-session graph: one recorded, one not. */
const twoSessionGraph = (id: string) => ({
  schema: 'process-graph/2', id, title: 'Two sessions', tags: ['smoke', 'sod'],
  systems: { sf: { label: 'Salesforce', kind: 'salesforce' } },
  actors: { a: 'sales_user', b: 'siebel_admin' },
  nodes: [
    { id: 'start', type: 'start', label: '' },
    { id: 's1', type: 'session', label: 'SF · a', system: 'sf', actor: 'a', steps: { status: 'captured' } },
    { id: 's2', type: 'session', label: 'SF · b', system: 'sf', actor: 'b' },
    { id: 'rec', type: 'data', label: 'Record', sobject: 'Account' },
    { id: 'end', type: 'end', label: '' },
  ],
  edges: [
    { id: 'l1', from: 'start', to: 's1', type: 'login_as' },
    { id: 'l2', from: 's1', to: 's2', type: 'login_as' },
    { id: 'd1', from: 's1', to: 'rec', type: 'does', data: { catalog: 'rec.create', io: 'produces' } },
    { id: 'd2', from: 's2', to: 'rec', type: 'does', data: { catalog: 'rec.open', io: 'consumes' } },
    { id: 'n', from: 'rec', to: 'end', type: 'next' },
  ],
});
const saveGraph = (project: string, graph: unknown) =>
  fetch(`${base}/__graphs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, graph, overwrite: true }) });
const makeProject = (project: string) =>
  fetch(`${base}/__projects`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project }) });

test('library: read fresh off disk per call — projects, legacy journeys, and a broken graph listed WITH its errors', async () => {
  expect((await makeProject('lib')).status).toBe(200);
  expect((await saveGraph('lib', twoSessionGraph('two_sessions'))).status).toBe(200);
  // Written behind the server's back — /__library must see it without a restart:
  fs.writeFileSync(path.join(tmp, 'projects', 'lib', 'graphs', 'broken_flow.graph.json'), JSON.stringify({
    schema: 'process-graph/2', id: 'broken_flow', systems: {}, actors: {},
    nodes: [{ id: 'lone', type: 'session', label: 'x' }], edges: [{ id: 'e', from: 'lone', to: 'ghost', type: 'next' }],
  }));
  fs.mkdirSync(path.join(tmp, 'journeys', 'graphs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'journeys', 'graphs', 'old_flow.graph.json'), JSON.stringify(twoSessionGraph('old_flow')));

  const j = await (await fetch(`${base}/__library`)).json();
  expect(j.ok).toBe(true);
  expect(j.version).toBe(1);

  const lib = j.projects.find((p: { name: string }) => p.name === 'lib');
  expect(lib.graphs.map((g: { ref: string }) => g.ref)).toEqual(['lib/broken_flow', 'lib/two_sessions']);
  expect(lib.graphs[1]).toEqual({
    ref: 'lib/two_sessions', id: 'two_sessions', title: 'Two sessions', tags: ['smoke', 'sod'],
    sessions: 2, captured: 1, file: 'projects/lib/graphs/two_sessions.graph.json',
  });
  // Listed, never hidden — a graph you cannot see is a graph you cannot fix:
  expect(lib.graphs[0].invalid).toEqual([
    'nodes.lone: session nodes require a system (the lane they log into)',
    "edges.e.to: unknown node 'ghost'",
  ]);

  expect(j.legacy.map((g: { ref: string; file: string }) => [g.ref, g.file]))
    .toEqual([['old_flow', 'journeys/graphs/old_flow.graph.json']]);

  // A graph saved AFTER this response is in the next one — no rebuild between.
  expect((await saveGraph('lib', twoSessionGraph('later_flow'))).status).toBe(200);
  const again = await (await fetch(`${base}/__library`)).json();
  expect(again.projects.find((p: { name: string }) => p.name === 'lib').graphs.map((g: { id: string }) => g.id))
    .toEqual(['broken_flow', 'later_flow', 'two_sessions']);
});

test('library: suites.json rides along, and a malformed one is an empty set rather than a 500', async () => {
  // The planner v2 Suites pane reads this key (goal 7). src/suites.ts owns the
  // MEANING; the server only does the I/O, so it must never refuse to list the
  // library because a suite is half-typed.
  const file = path.join(tmp, 'suites.json');
  fs.writeFileSync(file, JSON.stringify({
    smoke: { graphs: ['two_sessions', 42] },   // non-strings are dropped
    sod: { tags: ['sod'] },
    lib: { project: 'lib' },
    junk: 'not an object',                     // not a suite — skipped
  }));
  const j = await (await fetch(`${base}/__library`)).json();
  expect(j.ok).toBe(true);
  expect(j.suites).toEqual({
    smoke: { graphs: ['two_sessions'] },
    sod: { tags: ['sod'] },
    lib: { project: 'lib' },
  });

  fs.writeFileSync(file, '{ this is not json');
  expect((await (await fetch(`${base}/__library`)).json()).suites).toEqual({});
  fs.rmSync(file);
  expect((await (await fetch(`${base}/__library`)).json()).suites).toEqual({});
});

test('a saved graph is DATA: no rebuild, no reload pushed at the tab doing the saving', async () => {
  // The observable is the server's own log: rebuild() announces itself even
  // when PLANNER_NO_REBUILD short-circuits it.
  expect(log).toMatch(/rebuild skipped \(new project 'lib'\)/);  // the mechanism still works…
  expect(log).not.toMatch(/rebuild skipped \(saved /);           // …and a graph save never reaches it
  expect(log).not.toMatch(/reloading \d+ tab/);
});

test('record: POST spawns the recorder for a resolved journey, GET polls it to done', async () => {
  expect((await makeProject('rec')).status).toBe(200);
  expect((await saveGraph('rec', twoSessionGraph('tiny_flow'))).status).toBe(200);

  const r = await fetch(`${base}/__record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'sales_user', journey: 'tiny_flow', project: 'rec' }),
  });
  expect(r.status).toBe(200);
  const started = await r.json();
  expect(started).toMatchObject({ ok: true, ref: 'rec/tiny_flow', persona: 'sales_user' });
  expect(started.pid).toBeGreaterThan(0);
  expect(started.id).toMatch(/^rec_/);

  let status = await (await fetch(`${base}/__record/${started.id}`)).json();
  expect(['running', 'done']).toContain(status.status);
  await expect.poll(async () => (await (await fetch(`${base}/__record/${started.id}`)).json()).status, { timeout: 10_000 })
    .toBe('done');
  status = await (await fetch(`${base}/__record/${started.id}`)).json();
  expect(status).toMatchObject({ ok: true, ref: 'rec/tiny_flow', journey: 'tiny_flow', persona: 'sales_user', exitCode: 0 });
  // RECORD_PERSONA/RECORD_JOURNEY reached the child; its output is the tail.
  expect(status.tail).toEqual(['▶ RECORDING tiny_flow as sales_user']);
});

// S3.3 — the planner's "From a recording" door lists what `npm run record`
// left behind so the sheet can name the journey the pipeline command needs.
test('recordings: journeys under recordings/ with their captures, manifest first, directory name as the fallback', async () => {
  expect(await (await fetch(`${base}/__recordings`)).json()).toEqual({ ok: true, recordings: [] });

  const mk = (journey: string, run: string, manifest?: unknown) => {
    const dir = path.join(tmp, 'recordings', journey, run);
    fs.mkdirSync(dir, { recursive: true });
    if (manifest) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  };
  mk('lead_to_customer', 'sales_user-20260901-101500', {
    schema: 'sf-recording/1', journey: 'lead_to_customer', persona: 'sales_user', startedAt: '2026-09-01T10:15:00.000Z',
  });
  mk('lead_to_customer', 'siebel_admin-20260902-090000'); // no manifest — the name still says who and when
  mk('expense_to_siebel', 'sales_user-20260830-120000', '{ half written');
  fs.mkdirSync(path.join(tmp, 'recordings', 'empty_journey'), { recursive: true }); // no captures → not listed
  fs.writeFileSync(path.join(tmp, 'recordings', 'stray.txt'), 'not a journey');

  const j = await (await fetch(`${base}/__recordings`)).json();
  expect(j.ok).toBe(true);
  expect(j.recordings.map((r: { journey: string }) => r.journey)).toEqual(['expense_to_siebel', 'lead_to_customer']);
  const l2c = j.recordings[1];
  expect(l2c.runs).toEqual([
    { dir: 'recordings/lead_to_customer/sales_user-20260901-101500', persona: 'sales_user', at: '2026-09-01T10:15:00.000Z' },
    { dir: 'recordings/lead_to_customer/siebel_admin-20260902-090000', persona: 'siebel_admin', at: '20260902-090000' },
  ]);
  expect(l2c.latest).toBe('20260902-090000');
  // A half-written manifest is not a 500: the directory name still answers.
  expect(j.recordings[0].runs[0]).toEqual({
    dir: 'recordings/expense_to_siebel/sales_user-20260830-120000', persona: 'sales_user', at: '20260830-120000',
  });

  fs.rmSync(path.join(tmp, 'recordings'), { recursive: true, force: true });
});

test('record: one session per journey (409), unknown persona or journey refused, unknown id 404s', async () => {
  expect((await saveGraph('rec', twoSessionGraph('hold_flow'))).status).toBe(200);
  const first = await (await fetch(`${base}/__record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'sales_user', journey: 'rec/hold_flow' }), // ref form, no project field
  })).json();
  expect(first.ok).toBe(true);

  const second = await fetch(`${base}/__record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'siebel_admin', journey: 'hold_flow', project: 'rec' }),
  });
  expect(second.status).toBe(409);
  expect(await second.json()).toMatchObject({ ok: false, running: true, id: first.id });
  expect((await (await fetch(`${base}/__record/${first.id}`)).json()).status).toBe('running');

  const ghostPersona = await fetch(`${base}/__record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'nobody', journey: 'tiny_flow', project: 'rec' }),
  });
  expect(ghostPersona.status).toBe(400);
  expect((await ghostPersona.json()).error).toContain("unknown persona 'nobody'");

  const ghostJourney = await fetch(`${base}/__record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ persona: 'sales_user', journey: 'nope', project: 'rec' }),
  });
  expect(ghostJourney.status).toBe(400);
  expect((await ghostJourney.json()).error).toContain("unknown journey 'rec/nope'");

  const ghostId = await fetch(`${base}/__record/rec_nothing`);
  expect(ghostId.status).toBe(404);
});

test('wiring edits on a role bound to an account land on the ACCOUNT — every role on that login follows', async () => {
  const r = await (await fetch(`${base}/__personas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ personaId: 'client_lead', usernameEnv: 'SFDC_UAT_MGR_USER', totpEnv: '' }),
  })).json();
  expect(r.ok).toBe(true);
  expect(r.wiring.username).toBe('SFDC_UAT_MGR_USER');
  expect(r.wiring.totp).toBeUndefined();
  expect(r.wiring.account).toBe('sales_mgr');
  expect(r.wiringAll.business_development_manager.username).toBe('SFDC_UAT_MGR_USER'); // same login, same names
  const doc = personas();
  expect(doc.accounts.sales_mgr).toEqual({ auth: 'frontdoor', usernameEnv: 'SFDC_UAT_MGR_USER', totpEnv: '' });
  expect(doc.personas.client_lead).toEqual({ kind: 'internal', role: 'Client Lead', account: 'sales_mgr' }); // no wiring on the role
  expect(r.envstatus.SFDC_UAT_MGR_USER).toBe(false);
});