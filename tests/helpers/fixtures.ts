/**
 * The synthetic graphs the suite runs against — `tests/fixtures/graphs/` —
 * and the handful of things tests do with them.
 *
 * No shipped graph lives in `journeys/graphs/` any more: real process graphs
 * are customer material and stay under the gitignored `projects/`. What the
 * tests need instead is SHAPE — a multi-stage graph with api/db/logger
 * evidence nodes and painted snapshots (`request_to_fulfilment`), an
 * ADO-import-shaped draft (`imported_draft`), and the two-actor SoD hand-off
 * that lives in code as `goodGraphV2()` (tests/helpers/sampleGraph.ts).
 * Every name in them is deliberately generic.
 *
 * Evidence for `request_to_fulfilment` is six generated placeholder JPEGs
 * under tests/fixtures/evidence/ — the graph's snapshot refs resolve against
 * them exactly as a project graph's do against projects/<p>/evidence/.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { ProcessGraph } from '../../src/graph/schema';
import { goodGraphV2 } from './sampleGraph';

export const FIXTURES = path.resolve(__dirname, '../fixtures');
export const FIXTURE_GRAPHS = path.join(FIXTURES, 'graphs');

/** Ids of the on-disk fixture graphs (`<id>.graph.json`). */
export const FIXTURE_IDS = ['request_to_fulfilment', 'imported_draft'] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

export function fixturePath(id: FixtureId): string {
  return path.join(FIXTURE_GRAPHS, `${id}.graph.json`);
}

export function loadFixture(id: FixtureId): ProcessGraph {
  return JSON.parse(fs.readFileSync(fixturePath(id), 'utf8')) as ProcessGraph;
}

/** Every graph the suite treats as "shipped": the two files + the in-code SoD sample. */
export function allFixtureGraphs(): { id: string; file: string | null; graph: ProcessGraph }[] {
  return [
    ...FIXTURE_IDS.map((id) => ({ id, file: fixturePath(id), graph: loadFixture(id) })),
    { id: goodGraphV2().id, file: null, graph: goodGraphV2() },
  ];
}

/**
 * A throwaway repo-shaped root with `journeys/graphs/<id>.graph.json` for the
 * graphs named (fixture ids, or in-code graphs passed as objects) and, when
 * a fixture has evidence, its evidence folder beside them — so evidence refs
 * resolve there just as they do in the repo. Caller removes it.
 */
export function scratchRoot(graphs: (FixtureId | ProcessGraph)[] = [], prefix = 'fixture-root-'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'journeys', 'graphs');
  fs.mkdirSync(dir, { recursive: true });
  for (const g of graphs) {
    const graph = typeof g === 'string' ? loadFixture(g) : g;
    fs.writeFileSync(path.join(dir, `${graph.id}.graph.json`), JSON.stringify(graph, null, 2));
    if (typeof g === 'string') {
      const ev = path.join(FIXTURES, 'evidence', g);
      if (fs.existsSync(ev)) fs.cpSync(ev, path.join(root, 'journeys', 'evidence', g), { recursive: true });
    }
  }
  return root;
}
