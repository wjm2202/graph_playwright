/**
 * Self-service projects (DESIGN-PROJECTS.md §3): the scaffolder that teams
 * (CLI or planner) use to create their own project — no names hardcoded
 * anywhere — and the graph-ref resolver that lets every CLI address
 * `<project>/<id>` with a legacy fallback for the flat journeys/graphs/.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listGraphRefs, resolveGraphRef } from '../../src/graph/resolve';

const SCAFFOLD = path.resolve('tools', 'scaffold-project.mjs');

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
}

function scaffold(cwd: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', [SCAFFOLD, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const writeGraph = (file: string, id: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 'process-graph/2', id, systems: {}, actors: {}, nodes: [], edges: [] }));
};

test.describe('scaffolder (npm run project:new)', () => {
  test('creates the folder shape, manifest, and README with the team commands', () => {
    const root = tmpRoot();
    const r = scaffold(root, ['web_shop', '--team', 'Web']);
    expect(r.code, r.out).toBe(0);

    const dir = path.join(root, 'projects', 'web_shop');
    for (const sub of ['graphs', 'journeys/baselines', 'steps', 'specs', 'recordings', 'evidence', 'docs']) {
      expect(fs.existsSync(path.join(dir, sub)), sub).toBe(true);
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ project: 'web_shop', team: 'Web', systems: [], uses: [], namePrefix: 'E2E_WEB_SHOP' });
    const readme = fs.readFileSync(path.join(dir, 'docs', 'README.md'), 'utf8');
    expect(readme).toContain('GRAPH_DOCTOR=project:web_shop');
    expect(readme).toContain('GRILLME=web_shop/<graph_id>');
    // Asset dirs are kept in git; scratch dirs are not.
    expect(fs.existsSync(path.join(dir, 'graphs', '.gitkeep'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'recordings', '.gitkeep'))).toBe(false);
  });

  test('refuses bad names and duplicates, loudly', () => {
    const root = tmpRoot();
    expect(scaffold(root, ['Web Team']).code).not.toBe(0);
    expect(scaffold(root, ['1st']).code).not.toBe(0);
    expect(scaffold(root, ['shared']).code).not.toBe(0);
    expect(scaffold(root, []).code).not.toBe(0);
    expect(scaffold(root, ['siebel']).code).toBe(0);
    const dup = scaffold(root, ['siebel']);
    expect(dup.code).not.toBe(0);
    expect(dup.out).toContain('already exists');
  });
});

test.describe('graph-ref resolver', () => {
  const fixture = (): string => {
    const root = tmpRoot();
    writeGraph(path.join(root, 'journeys', 'graphs', 'legacy_flow.graph.json'), 'legacy_flow');
    writeGraph(path.join(root, 'journeys', 'graphs', 'checkout.graph.json'), 'checkout');
    writeGraph(path.join(root, 'projects', 'web', 'graphs', 'checkout.graph.json'), 'checkout');
    writeGraph(path.join(root, 'projects', 'siebel', 'graphs', 'sync.graph.json'), 'sync');
    return root;
  };

  test('project/id resolves directly; bare unique ids resolve with their owner', () => {
    const root = fixture();
    expect(resolveGraphRef('web/checkout', root)).toMatchObject({ project: 'web', ref: 'web/checkout', id: 'checkout' });
    expect(resolveGraphRef('sync', root)).toMatchObject({ project: 'siebel', ref: 'siebel/sync' });
    expect(resolveGraphRef('legacy_flow', root)).toMatchObject({ ref: 'legacy_flow' });
    expect(resolveGraphRef('legacy_flow', root).project).toBeUndefined();
  });

  test('ambiguous bare ids error listing every candidate ref', () => {
    const root = fixture();
    expect(() => resolveGraphRef('checkout', root)).toThrow(/more than one place.*checkout.*web\/checkout/s);
  });

  test('a miss lists everything available', () => {
    const root = fixture();
    expect(() => resolveGraphRef('nope', root)).toThrow(/available: .*legacy_flow.*siebel\/sync.*web\/checkout/s);
    expect(() => resolveGraphRef('web/nope', root)).toThrow(/no such graph 'web\/nope'/);
  });

  test('listGraphRefs: legacy first as bare ids, then projects alphabetically', () => {
    const root = fixture();
    expect(listGraphRefs(root).map((r) => r.ref)).toEqual([
      'checkout', 'legacy_flow', 'siebel/sync', 'web/checkout',
    ]);
  });
});
