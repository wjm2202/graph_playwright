/**
 * S6 — grillme CLI (the skill's hands):
 *   GRILLME=lead_to_customer npm run grillme                 → gaps as JSON + prose
 *   GRILLME=lead_to_customer GRILLME_APPLY=answers.json ...  → apply ops, save graph
 * answers.json = GrillmeOp[] (see src/graph/gaps.ts).
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { computeGaps, applyAnswers, type GrillmeOp } from '../../src/graph/gaps';
import { chainHealth } from '../../src/graph/compose';
import { resolveGraphRef } from '../../src/graph/resolve';
import { PersonaRegistry } from '../../src/personas/registry';
import type { ProcessGraph } from '../../src/graph/schema';

test('list gaps or apply grillme answers to a graph', async () => {
  test.skip(!process.env.GRILLME, 'set GRILLME=<graph_id | project/graph_id> (+ GRILLME_APPLY=<ops.json> to write back)');
  const id = process.env.GRILLME ?? '';
  const file = resolveGraphRef(id).file;
  const graph = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;

   
  if (process.env.GRILLME_APPLY) {
    const ops = JSON.parse(fs.readFileSync(process.env.GRILLME_APPLY ?? '', 'utf8')) as GrillmeOp[];
    const r = applyAnswers(graph, ops);
    fs.writeFileSync(file, JSON.stringify(r.graph, null, 2) + '\n');
    console.log(`✔ ${r.changes.length} answers applied to ${file}:`);
    for (const c of r.changes) console.log(`  · ${c}`);
  }

  const current = JSON.parse(fs.readFileSync(file, 'utf8')) as ProcessGraph;
  const gaps = computeGaps(current, { knownPersonas: PersonaRegistry.load().ids() });
  const chain = chainHealth(current);
  for (const err of chain.errors) console.log(`  [chain] MUST FIX: ${err}`);
  for (const sess of chain.stranded) console.log(`  [chain] session '${sess}' is not on the login chain — a run will never reach it`);
  console.log(`\ngaps for '${id}': ${gaps.length}`);
  for (const gap of gaps) console.log(`  [${gap.kind}] ${gap.at}: ${gap.question}${gap.options ? `  (${gap.options.join(' / ')})` : ''}`);
  console.log('\nGAPS_JSON ' + JSON.stringify(gaps));
  if (!gaps.length) console.log('✔ nothing left to ask — remaining work is captures (see not_captured above if any) and running it');
   
});
