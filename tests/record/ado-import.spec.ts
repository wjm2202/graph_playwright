/**
 * S5 — ado:import CLI:
 *   ADO_FILE=path/to/export.csv npm run ado:import       (CSV export)
 *   ADO_PASTE="Title: x\n1. as a user, ... | ..." npm run ado:import
 * Writes journeys/graphs/<slug>.graph.json as a DRAFT (never overwrites an
 * existing graph — suffixes _ado) and prints every confidence flag for
 * grillme/human review.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { adoCaseToGraph, parseAdoCsv, parseAdoPaste, writeAdoGraph } from '../../src/graph/fromAdo';
import { PersonaRegistry } from '../../src/personas/registry';

test('import an ADO test plan into draft process graphs', async () => {
  test.skip(!process.env.ADO_FILE && !process.env.ADO_PASTE, 'set ADO_FILE=<csv> or ADO_PASTE=<text>');

  const cases = process.env.ADO_FILE
    ? parseAdoCsv(fs.readFileSync(process.env.ADO_FILE ?? '', 'utf8'))
    : [parseAdoPaste(process.env.ADO_PASTE ?? '')];
  if (!cases.length) throw new Error('no test cases found in the input');

  const knownPersonas = PersonaRegistry.load().ids();
   
  for (const tc of cases) {
    const written = writeAdoGraph(adoCaseToGraph(tc, { knownPersonas }));
    console.log(`\n✔ draft graph: ${written.graphFile}  (${written.graph.nodes.length} nodes, ${written.graph.edges.length} edges)`);
    for (const f of written.flags) console.log(`  ⚑ ${f}`);
    console.log(`  next: open it in the planner (npm run planner) — confirm the draft? checks, bind roles, then capture`);
  }
   
});
