/**
 * S4.2 — tools/migrate-evidence.mjs: the one-off that moves ALREADY PAINTED
 * inline snapshots out of a graph and into its evidence folder, so a customer
 * (and this repo's own `lead_to_customer`) does not have to re-run anything
 * to get a graph whose diffs can be read.
 *
 * Driven as the CLI it is (`node tools/migrate-evidence.mjs …`, the same way
 * `tests/unit/projects.spec.ts` drives the scaffolder), always on a tmp copy
 * — no test ever rewrites a graph in the repo. The refs it writes are checked
 * with `resolveEvidenceRef` from src/graph/evidence.ts, so the tool's layout
 * rule and the runtime's cannot drift apart unnoticed.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { evidenceDirFor, resolveEvidenceRef } from '../../src/graph/evidence';

const TOOL = path.resolve('tools', 'migrate-evidence.mjs');
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const dataUrl = (mime = 'image/png') => `data:${mime};base64,${PIXEL.toString('base64')}`;

interface Snap { status: string; ref?: string; capturedAt?: string }
interface Node { id: string; type: string; label?: string; snapshot?: Snap; expects?: { id: string; kind: string; lastResult?: { status: string; at: string; runId?: string } }[] }
interface Graph { schema: string; id: string; systems: Record<string, unknown>; actors: Record<string, unknown>; nodes: Node[]; edges: unknown[] }

const graphWith = (nodes: Node[], id = 'demo_flow'): Graph => ({
  schema: 'process-graph/2', id, systems: {}, actors: {}, nodes, edges: [],
});

/** <root>/graphs/<id>.graph.json — the shape the layout rule expects. */
function scratch(graph: Graph): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-'));
  fs.mkdirSync(path.join(root, 'graphs'));
  const file = path.join(root, 'graphs', `${graph.id}.graph.json`);
  fs.writeFileSync(file, JSON.stringify(graph, null, 2) + '\n');
  return { root, file };
}

function migrate(args: string[]): { code: number; out: string } {
  try {
    return { code: 0, out: execFileSync('node', [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

const painted = (id: string, runId?: string, ref?: string): Node => ({
  id, type: 'session', label: id,
  ...(ref === undefined ? {} : { snapshot: { status: 'captured', ref, capturedAt: 'then' } }),
  expects: [{ id: `${id}_x`, kind: 'ui.text', ...(runId ? { lastResult: { status: 'pass', at: 'then', runId } } : {}) }],
});

test('inline snapshots become files under the graph\'s evidence folder, and the refs become paths', () => {
  const s = scratch(graphWith([
    painted('sess_a', 'sim_zz', dataUrl()),
    { id: 'chk_b', type: 'checkpoint', label: 'B', snapshot: { status: 'captured', ref: dataUrl('image/jpeg') } },
    { id: 'plain', type: 'data', label: 'C' },
  ]));

  const r = migrate([s.file]);
  expect(r.code, r.out).toBe(0);
  expect(r.out).toContain('2 image(s)');

  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8')) as Graph;
  const snap = saved.nodes[0]!.snapshot!;
  // The runId is the graph's OWN paint — evidence stays joined to the run.
  expect(snap.ref).toBe('evidence/demo_flow/sim_zz/sess_a.png');
  expect(snap.capturedAt).toBe('then');                        // metadata untouched
  expect(saved.nodes[1]!.snapshot!.ref).toBe('evidence/demo_flow/sim_zz/chk_b.jpg');
  expect(saved.nodes[2]!.snapshot).toBeUndefined();
  expect(JSON.stringify(saved)).not.toContain('base64');

  // The tool's layout rule IS src/graph/evidence.ts's:
  const onDisk = resolveEvidenceRef(s.file, snap.ref)!;
  expect(onDisk).toBe(path.join(evidenceDirFor(s.file), 'demo_flow', 'sim_zz', 'sess_a.png'));
  expect(fs.readFileSync(onDisk)).toEqual(PIXEL);
  expect(fs.readdirSync(path.join(s.root, 'evidence', 'demo_flow', 'sim_zz')).sort())
    .toEqual(['chk_b.jpg', 'sess_a.png']);
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('a graph that names no single runId files its evidence under "migrated"', () => {
  const s = scratch(graphWith([painted('sess_a', 'r1', dataUrl()), painted('sess_b', 'r2', dataUrl())]));
  expect(migrate([s.file]).code).toBe(0);
  const saved = JSON.parse(fs.readFileSync(s.file, 'utf8')) as Graph;
  expect(saved.nodes[0]!.snapshot!.ref).toBe('evidence/demo_flow/migrated/sess_a.png');
  expect(saved.nodes[1]!.snapshot!.ref).toBe('evidence/demo_flow/migrated/sess_b.png');
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('idempotent: a second pass moves nothing and rewrites nothing', () => {
  const s = scratch(graphWith([painted('sess_a', 'sim_zz', dataUrl())]));
  migrate([s.file]);
  const after = fs.readFileSync(s.file, 'utf8');

  const again = migrate([s.file]);
  expect(again.code).toBe(0);
  expect(again.out).toContain('nothing inline (1 file ref(s) already)');
  expect(fs.readFileSync(s.file, 'utf8')).toBe(after);          // byte-identical
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('--dry-run writes neither the images nor the graph', () => {
  const s = scratch(graphWith([painted('sess_a', 'sim_zz', dataUrl())]));
  const before = fs.readFileSync(s.file, 'utf8');
  const r = migrate(['--dry-run', s.file]);
  expect(r.out).toContain('dry run');
  expect(fs.readFileSync(s.file, 'utf8')).toBe(before);
  expect(fs.existsSync(path.join(s.root, 'evidence'))).toBe(false);
  fs.rmSync(s.root, { recursive: true, force: true });
});

test('it says what to do with no arguments, and names a file it cannot read', () => {
  expect(migrate([]).code).toBe(2);
  expect(migrate([]).out).toContain('usage: node tools/migrate-evidence.mjs');
  const ghost = migrate([path.join(os.tmpdir(), 'no-such-graph.json')]);
  expect(ghost.code).toBe(1);
  expect(ghost.out).toContain('no such file');
});

test('the shipped lead_to_customer graph is migrated: file refs, no base64, images on disk', () => {
  // The outcome of the one-off, guarded so nobody re-inlines it by accident.
  const file = path.resolve('journeys/graphs/lead_to_customer.graph.json');
  const text = fs.readFileSync(file, 'utf8');
  expect(text).not.toContain('base64');
  expect(fs.statSync(file).size).toBeLessThan(30_000);          // was 91 KB

  const graph = JSON.parse(text) as Graph;
  const snaps = graph.nodes.filter((n) => n.snapshot?.ref);
  expect(snaps.length).toBe(6);
  for (const n of snaps) {
    expect(n.snapshot!.ref, n.id).toMatch(/^evidence\/lead_to_customer\/[a-z0-9_]+\/[a-z0-9_]+\.jpg$/);
    expect(fs.existsSync(resolveEvidenceRef(file, n.snapshot!.ref)!), `${n.id} → ${n.snapshot!.ref}`).toBe(true);
  }
});
