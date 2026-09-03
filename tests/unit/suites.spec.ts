/**
 * Suites — the selection half of goal 7. `suites.json` names sets of graphs;
 * `selectGraphs` resolves a `SUITE` spec (suite name, `graph:` / `tag:` /
 * `project:` selector, or a comma list) to canonical refs. The second half is
 * `tests/e2e/graphs.spec.ts`, the ONE spec that registers a test per
 * graph × persona-matrix binding — the last test here proves the two halves
 * meet by listing the real suite through Playwright.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadSuites, selectGraphs, suiteMembers } from '../../src/suites';
import { loadGraphFile, resolveGraphRef } from '../../src/graph/resolve';
import { expandVariants } from '../../src/graph/toJourney';
import type { ProcessGraph } from '../../src/graph/schema';
import { goodGraphV2 } from '../helpers/sampleGraph';

const REPO = path.resolve(__dirname, '../..');

/** A scratch repo: legacy graphs, one project, and a suites.json. */
function scratchRepo(suites: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-'));
  const write = (file: string, graph: ProcessGraph) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(graph, null, 2));
  };
  const g = (id: string, tags?: string[]): ProcessGraph => {
    // The sample carries tags of its own — this fixture decides them.
    const { tags: _sample, ...base } = goodGraphV2();
    return { ...base, id, ...(tags ? { tags } : {}) };
  };
  write(path.join(root, 'journeys/graphs/alpha.graph.json'), g('alpha', ['smoke', 'sod']));
  write(path.join(root, 'journeys/graphs/beta.graph.json'), g('beta', ['smoke']));
  write(path.join(root, 'journeys/graphs/gamma.graph.json'), g('gamma'));
  write(path.join(root, 'projects/crm/graphs/delta.graph.json'), g('delta', ['sod']));
  write(path.join(root, 'projects/crm/graphs/epsilon.graph.json'), g('epsilon'));
  fs.writeFileSync(path.join(root, 'suites.json'), JSON.stringify(suites, null, 2));
  return root;
}

const SUITES = {
  smoke: { graphs: ['alpha', 'crm/delta'] },
  sod: { tags: ['sod'] },
  crm: { project: 'crm' },
  everything: { graphs: ['gamma'], tags: ['smoke'], project: 'crm' },
  nothing: { tags: ['no_one_uses_this'] },
};

test.describe('selection', () => {
  test('by suite name: explicit graphs, tags, project — and the union of all three', () => {
    const root = scratchRepo(SUITES);
    expect(selectGraphs('smoke', root)).toEqual(['alpha', 'crm/delta']);
    expect(selectGraphs('sod', root)).toEqual(['alpha', 'crm/delta']);
    expect(selectGraphs('crm', root)).toEqual(['crm/delta', 'crm/epsilon']);
    expect(selectGraphs('everything', root)).toEqual(['alpha', 'beta', 'crm/delta', 'crm/epsilon', 'gamma']);
    // A tag nothing carries is empty, not an error: tags are free labels.
    expect(selectGraphs('nothing', root)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('by direct selector: graph: (ref or bare id), tag:, project:', () => {
    const root = scratchRepo(SUITES);
    expect(selectGraphs('graph:beta', root)).toEqual(['beta']);
    expect(selectGraphs('graph:crm/epsilon', root)).toEqual(['crm/epsilon']);
    expect(selectGraphs('tag:sod', root)).toEqual(['alpha', 'crm/delta']);
    expect(selectGraphs('project:crm', root)).toEqual(['crm/delta', 'crm/epsilon']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a comma list unions its terms, deduplicated and sorted (deterministic order)', () => {
    const root = scratchRepo(SUITES);
    // Deliberately out of order and overlapping — the result is neither.
    expect(selectGraphs('project:crm, graph:beta ,smoke,tag:sod', root)).toEqual([
      'alpha', 'beta', 'crm/delta', 'crm/epsilon',
    ]);
    expect(selectGraphs('smoke,smoke', root)).toEqual(selectGraphs('smoke', root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a typo is loud: unknown suite names the available ones, unknown graph/project too', () => {
    const root = scratchRepo(SUITES);
    expect(() => selectGraphs('smok', root)).toThrow(/no such suite 'smok' — available: crm, everything, nothing, smoke, sod/);
    expect(() => selectGraphs('smok', root)).toThrow(/graph:<ref> \| tag:<t> \| project:<p>/);
    expect(() => selectGraphs('graph:nope', root)).toThrow(/no such graph 'nope' — available: alpha, beta, gamma, crm\/delta/);
    expect(() => selectGraphs('project:erm', root)).toThrow(/no such project 'erm' — available: crm/);
    expect(() => selectGraphs('  ', root)).toThrow(/SUITE is empty/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('no suites.json at all: direct selectors still work, a name says nothing is defined', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suites-none-'));
    expect(loadSuites(root)).toEqual({});
    expect(() => selectGraphs('smoke', root)).toThrow(/\(none defined in suites\.json\)/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('a malformed suites.json is refused where it is read, not where it runs', () => {
    for (const [doc, message] of [
      [['smoke'], /must be an object of/],
      [{ smoke: 'alpha' }, /suite 'smoke' must be an object with graphs \/ tags \/ project/],
      [{ smoke: { graphs: 'alpha' } }, /suite 'smoke'\.graphs must be an array of non-empty strings/],
      [{ smoke: { project: 3 } }, /suite 'smoke'\.project must be a project name/],
      [{ smoke: {} }, /suite 'smoke' selects nothing/],
    ] as [unknown, RegExp][]) {
      const root = scratchRepo(doc);
      expect(() => loadSuites(root), JSON.stringify(doc)).toThrow(message);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe('the shipped suites.json', () => {
  test('smoke, sod and salesforce resolve against this repo', () => {
    const suites = loadSuites(REPO);
    expect(Object.keys(suites).sort()).toEqual(['salesforce', 'smoke', 'sod']);
    expect(suiteMembers('smoke', REPO)).toEqual(['expense_to_siebel', 'lead_to_customer']);
    // Tagging is what makes `sod` non-empty — it must not rot to nothing.
    expect(suiteMembers('sod', REPO).length).toBeGreaterThan(0);
  });
});

test.describe('tests/e2e/graphs.spec.ts', () => {
  test('registers one test per graph × persona-matrix binding for the named suite', () => {
    // --list needs no org: the e2e tests self-skip at run time, they still
    // register. This is the contract the deleted per-graph codegen used to
    // provide, now proven end to end through Playwright itself.
    // The child must not inherit this run's worker wiring, or Playwright
    // refuses to start inside Playwright.
    const env: NodeJS.ProcessEnv = { SUITE: 'smoke' };
    for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('PW_')) env[k] = v;

    const out = execFileSync(
      'npx',
      ['playwright', 'test', '--project=e2e', '--list', '--reporter=list', 'tests/e2e/graphs.spec.ts'],
      { cwd: REPO, encoding: 'utf8', env },
    );
    const titles = [...out.matchAll(/graphs\.spec\.ts:\d+:\d+ › (.+)$/gm)].map((m) => m[1]!.trim());

    const expected = selectGraphs('smoke', REPO).flatMap((ref) => {
      const graph = loadGraphFile(resolveGraphRef(ref, REPO).file);
      return expandVariants(graph).map((v) => (v.id === 'default' ? ref : `${ref} · as ${v.label}`));
    });
    expect(expected.length).toBeGreaterThanOrEqual(2);
    expect(titles).toEqual(expected);
  });
});
