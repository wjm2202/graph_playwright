/**
 * Sprint 4.3 — the `sfpw` CLI as a CLI.
 *
 * The eight commands this replaced were Playwright specs gated on env vars,
 * which meant a typo'd `GRILLME=` exited 0 and looked like a pass. So what is
 * pinned here is the contract a command line owes its caller:
 *
 *   · every command answers --help (exit 0);
 *   · an unknown command or a missing argument is exit 2 with usage on
 *     STDERR and nothing on stdout;
 *   · "not ready" is exit 1, and it is a sentence, not a stack trace;
 *   · `grillme --json` puts the Gap[] array on stdout and NOTHING else —
 *     that is the contract the /grillme skill parses (it replaced scraping a
 *     `GAPS_JSON …` line out of a test reporter's output);
 *   · the four browser commands delegate to Playwright with the right env,
 *     and refuse bad usage BEFORE starting a browser (--dry-run shows the
 *     exact command, which is how this suite checks the wiring).
 */
import { test, expect } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { goodGraphV2 } from '../helpers/sampleGraph';
import type { ProcessGraph } from '../../src/graph/schema';

const ROOT = path.resolve(__dirname, '../..');
const SFPW = path.join(ROOT, 'bin', 'sfpw.mjs');

interface Run {
  code: number;
  out: string;
  err: string;
}

/** Spawn the real bin. Org env is stripped: these tests must not depend on
 *  whoever's .env the developer has loaded (playwright.config reads one). */
function sfpw(argv: string[], cwd: string = ROOT): Run {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^(SF_|SFDC_|SIEBEL)/.test(k)),
  );
  const r = spawnSync(process.execPath, [SFPW, ...argv], { cwd, encoding: 'utf8', env });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const COMMANDS = [
  'doctor', 'grillme', 'compose', 'import', 'pipeline', 'contracts',
  'sweep', 'suite', 'record', 'simulate', 'fixture:trace', 'fixture:artifacts',
];

/** A repo-shaped scratch directory: personas.json + journeys/graphs/, no .env. */
function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpw-'));
  fs.copyFileSync(path.join(ROOT, 'personas.json'), path.join(root, 'personas.json'));
  fs.mkdirSync(path.join(root, 'journeys', 'graphs'), { recursive: true });
  return root;
}

function writeGraph(root: string, graph: ProcessGraph): string {
  const file = path.join(root, 'journeys', 'graphs', `${graph.id}.graph.json`);
  fs.writeFileSync(file, JSON.stringify(graph, null, 2) + '\n');
  return file;
}

const readGraph = (file: string): ProcessGraph => JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;

test.describe('grammar', () => {
  test('--help lists every command and exits 0', () => {
    const r = sfpw(['--help']);
    expect(r.code).toBe(0);
    for (const command of COMMANDS) expect(r.out, `--help must list ${command}`).toContain(command);
    expect(r.out).toContain('exit codes:');
    expect(r.err).toBe('');
  });

  test('no arguments is help, not an error', () => {
    const r = sfpw([]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('usage: sfpw <command>');
  });

  test('an unknown command exits 2 with usage on stderr and nothing on stdout', () => {
    const r = sfpw(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.out).toBe('');
    expect(r.err).toContain("unknown command 'frobnicate'");
    expect(r.err).toContain('usage: sfpw <command>');
  });

  test('an unknown OPTION exits 2 — the typo that used to pass silently', () => {
    const r = sfpw(['grillme', 'expense_to_siebel', '--jsonn']);
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown option '--jsonn'");
  });

  for (const command of COMMANDS) {
    test(`${command} --help exits 0 with its own usage`, () => {
      const r = sfpw([command, '--help']);
      expect(r.code, r.err).toBe(0);
      expect(r.out).toContain(`usage: sfpw ${command}`);
    });
  }
});

test.describe('doctor', () => {
  test('reports the missing .env lines and exits 1 so CI can gate on it', () => {
    const root = tmpRoot();
    writeGraph(root, goodGraphV2());
    const r = sfpw(['doctor', 'all'], root);
    expect(r.code, r.out + r.err).toBe(1);
    expect(r.out).toContain('[expense_to_siebel]');
    expect(r.out).toContain('SF_INSTANCE_URL=');
    expect(r.out).toContain('not runnable yet');
  });

  test('a root with no graphs at all fails with a sentence, not a stack trace', () => {
    const r = sfpw(['doctor'], tmpRoot());
    expect(r.code).toBe(1);
    expect(r.err).toContain('no graphs found');
    expect(r.err).not.toContain('    at ');
  });

  test('an unknown ref names what IS available', () => {
    const root = tmpRoot();
    writeGraph(root, goodGraphV2());
    const r = sfpw(['doctor', 'no_such_graph'], root);
    expect(r.code).toBe(1);
    expect(r.err).toContain('expense_to_siebel');
  });
});

test.describe('grillme', () => {
  test('--json prints exactly one thing: the Gap[] array', () => {
    const root = tmpRoot();
    writeGraph(root, goodGraphV2());
    const r = sfpw(['grillme', 'expense_to_siebel', '--json'], root);
    expect(r.code, r.err).toBe(0);
    // One line, and it parses as an array of gaps — the /grillme contract.
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    const gaps: unknown = JSON.parse(r.out);
    expect(Array.isArray(gaps)).toBe(true);
    for (const gap of gaps as { kind: string; question: string }[]) {
      expect(typeof gap.kind).toBe('string');
      expect(typeof gap.question).toBe('string');
    }
  });

  test('without --json it is prose, with the gap count', () => {
    const root = tmpRoot();
    writeGraph(root, goodGraphV2());
    const r = sfpw(['grillme', 'expense_to_siebel'], root);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/gaps for 'expense_to_siebel': \d+/);
  });

  test('--apply writes the answers back to the graph', () => {
    const root = tmpRoot();
    const file = writeGraph(root, goodGraphV2());
    const ops = path.join(root, 'ops.json');
    fs.writeFileSync(ops, JSON.stringify([{ op: 'bindRole', alias: 'submitter', personaId: 'admin' }]));

    const r = sfpw(['grillme', 'expense_to_siebel', '--apply', ops], root);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('1 answers applied');
    expect(readGraph(file).actors.submitter).toBe('admin');
  });

  test('a missing ref is a usage error, not a crash', () => {
    const r = sfpw(['grillme'], tmpRoot());
    expect(r.code).toBe(2);
    expect(r.err).toContain('grillme needs a graph ref');
  });
});

test.describe('compose', () => {
  const sub = (): ProcessGraph => ({
    schema: 'process-graph/2',
    id: 'add_address',
    title: 'Add address',
    systems: { sf: { label: 'Salesforce UAT', kind: 'salesforce', urlEnv: 'SF_INSTANCE_URL' } },
    actors: { submitter: 'sales_user' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_sf_sales', type: 'session', label: 'Salesforce · submitter', system: 'sf', actor: 'submitter' },
      { id: 'address', type: 'data', label: 'Address', expects: [{ id: 'address_saved', kind: 'ui.toast', value: 'saved', after: 'addr.add' }] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 's1', from: 'start', to: 'sess_sf_sales', type: 'login_as', data: { auth: 'frontdoor' } },
      { id: 's2', from: 'sess_sf_sales', to: 'address', type: 'does', label: 'add address', data: { catalog: 'addr.add' } },
      { id: 's3', from: 'address', to: 'end', type: 'next' },
    ],
  });

  test('writes the composed graph into the HOST file and leaves the sub alone', () => {
    const root = tmpRoot();
    const hostFile = writeGraph(root, goodGraphV2());
    const subFile = writeGraph(root, sub());
    const before = fs.readFileSync(subFile, 'utf8');

    const r = sfpw(['compose', 'expense_to_siebel', 'add_address'], root);
    expect(r.code, r.err).toBe(0);
    expect(readGraph(hostFile).nodes.some((n) => n.id.endsWith('address'))).toBe(true);
    expect(fs.readFileSync(subFile, 'utf8')).toBe(before);
    expect(r.out).toContain('composed into');
  });

  test('--island and --after are opposites', () => {
    const root = tmpRoot();
    writeGraph(root, goodGraphV2());
    writeGraph(root, sub());
    const r = sfpw(['compose', 'expense_to_siebel', 'add_address', '--island', '--after', 'sess_sf_sales'], root);
    expect(r.code).toBe(2);
    expect(r.err).toContain('opposites');
  });

  test('one ref is not enough', () => {
    const r = sfpw(['compose', 'expense_to_siebel'], tmpRoot());
    expect(r.code).toBe(2);
    expect(r.err).toContain('host ref and a sub ref');
  });
});

test.describe('import', () => {
  /** Steps exactly as ADO stores them: XML with HTML-encoded rich text. */
  const STEPS_XML = `<steps id="0" last="2">
  <step id="1" type="ActionStep">
    <parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;As a lead creator, create a new lead&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>
    <parameterizedString isformatted="true">&lt;DIV&gt;Lead record is created and saved&lt;/DIV&gt;</parameterizedString>
  </step>
  <step id="2" type="ActionStep">
    <parameterizedString isformatted="true">As a lead approver, progress the lead</parameterizedString>
    <parameterizedString isformatted="true">Toast shows "Lead updated"</parameterizedString>
  </step>
</steps>`;

  function csv(root: string): string {
    const file = path.join(root, 'export.csv');
    fs.writeFileSync(
      file,
      [
        'ID,Work Item Type,Title,State,Steps',
        `123,Test Case,Lead intake,Design,"${STEPS_XML.replace(/"/g, '""')}"`,
      ].join('\r\n'),
    );
    return file;
  }

  test('a CSV export becomes draft graphs under journeys/graphs/', () => {
    const root = tmpRoot();
    const r = sfpw(['import', csv(root)], root);
    expect(r.code, r.err).toBe(0);
    const written = fs.readdirSync(path.join(root, 'journeys', 'graphs'));
    expect(written).toHaveLength(1);
    expect(r.out).toContain('draft graph:');
    const graph = readGraph(path.join(root, 'journeys', 'graphs', written[0]!));
    expect(graph.schema).toBe('process-graph/2');
    expect(graph.nodes.length).toBeGreaterThan(0);
  });

  test('--paste reads a text file of steps', () => {
    const root = tmpRoot();
    const file = path.join(root, 'pasted.txt');
    fs.writeFileSync(file, ['Title: Quick expense check', '1. As a submitter, submit an expense | Expense record is saved'].join('\n'));
    const r = sfpw(['import', '--paste', file], root);
    expect(r.code, r.err).toBe(0);
    expect(fs.readdirSync(path.join(root, 'journeys', 'graphs'))).toHaveLength(1);
  });

  test('a file AND --paste is a usage error; neither is too', () => {
    const root = tmpRoot();
    expect(sfpw(['import', csv(root), '--paste', 'x.txt'], root).code).toBe(2);
    const empty = sfpw(['import'], root);
    expect(empty.code).toBe(2);
    expect(empty.err).toContain('--paste');
  });
});

test.describe('sweep', () => {
  test('with no org configured it says so and exits 1 — no stack trace', () => {
    const r = sfpw(['sweep'], tmpRoot());
    expect(r.code).toBe(1);
    expect(r.err).toContain('SF_ACCESS_TOKEN');
    expect(r.err).not.toContain('    at ');
    expect(r.out).toBe('');
  });
});

test.describe('the four commands that still need a browser', () => {
  test('suite passes unknown flags through to Playwright with SUITE set', () => {
    const r = sfpw(['suite', 'smoke', '--list', '--dry-run']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe('SUITE=smoke playwright test --project=e2e --list');
  });

  test('suite defaults to the smoke selection', () => {
    const r = sfpw(['suite', '--dry-run']);
    expect(r.out.trim()).toBe('SUITE=smoke playwright test --project=e2e');
  });

  test('record delegates to the record spec, headed, with the persona env set', () => {
    const r = sfpw(['record', 'sales_user', 'expense_v2', '--expect-denial', '--dry-run']);
    expect(r.code, r.err).toBe(0);
    expect(r.out.trim()).toBe(
      'RECORD_PERSONA=sales_user RECORD_JOURNEY=expense_v2 RECORD_EXPECT_DENIAL=1 ' +
        'playwright test --project=record tests/record/record.spec.ts --headed',
    );
  });

  test('simulate delegates to the simulate spec', () => {
    const r = sfpw(['simulate', 'expense_to_siebel', '--overwrite', '--dry-run']);
    expect(r.out.trim()).toBe(
      'SIMULATE=expense_to_siebel SIMULATE_OVERWRITE=1 playwright test --project=record tests/record/simulate.spec.ts',
    );
  });

  test('the fixture generators delegate with GEN_FIXTURE=1', () => {
    expect(sfpw(['fixture:trace', '--dry-run']).out.trim()).toBe(
      'GEN_FIXTURE=1 playwright test --project=record tests/record/make-fixture-trace.spec.ts',
    );
    expect(sfpw(['fixture:artifacts', '--dry-run']).out.trim()).toBe(
      'GEN_FIXTURE=1 playwright test --project=record tests/record/make-fixture-artifacts.spec.ts',
    );
  });

  test('record and simulate refuse bad usage BEFORE starting a browser', () => {
    for (const argv of [['record'], ['record', 'sales_user'], ['simulate']]) {
      const r = sfpw(argv);
      expect(r.code, argv.join(' ')).toBe(2);
      expect(r.out).toBe('');
      // Nothing Playwright-shaped ran: no reporter output, no browser.
      expect(r.err).not.toContain('Running');
    }
  });
});

test.describe('the retirement', () => {
  test('only the browser-needing specs are left in tests/record/', () => {
    expect(fs.readdirSync(path.join(ROOT, 'tests', 'record')).sort()).toEqual([
      'make-fixture-artifacts.spec.ts',
      'make-fixture-trace.spec.ts',
      'record.spec.ts',
      'simulate.spec.ts',
    ]);
  });

  test('the npm aliases point at the bin, and package.json exposes it', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      bin: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.bin.sfpw).toBe('bin/sfpw.mjs');
    for (const [script, command] of Object.entries({
      doctor: 'doctor', grillme: 'grillme', 'graph:compose': 'compose', 'ado:import': 'import',
      pipeline: 'pipeline', sweep: 'sweep', suite: 'suite', record: 'record', simulate: 'simulate',
    })) {
      expect(pkg.scripts[script], `npm run ${script}`).toBe(`node bin/sfpw.mjs ${command}`);
    }
  });

  test('CI no longer runs the record project (it had nothing left to run)', () => {
    const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci).not.toContain('--project=record');
  });
});
