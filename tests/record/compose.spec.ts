/**
 * Compose CLI — extend one graph with another (DESIGN-PROJECTS.md reuse):
 *   COMPOSE=<host_ref> COMPOSE_WITH=<sub_ref> [COMPOSE_AFTER=<session_id>] npm run graph:compose
 *
 * Default is ISLAND: the sub arrives intact but unwired — connect it in the
 * planner (chain health lists the stranded sessions). COMPOSE_AFTER opts into
 * the auto-splice (sessions merge, chain spliced after that session).
 * Copy-merge with provenance: the HOST file is rewritten (validated first,
 * git is the undo); the sub is never touched. Refs accept <project>/<id> or
 * bare ids like every other CLI.
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import { composeGraphs } from '../../src/graph/compose';
import { resolveGraphRef } from '../../src/graph/resolve';
import type { ProcessGraph } from '../../src/graph/schema';

test('import one graph into another', async () => {
  test.skip(!process.env.COMPOSE || !process.env.COMPOSE_WITH, 'set COMPOSE=<host_ref> COMPOSE_WITH=<sub_ref> (+ COMPOSE_AFTER=<host session id>)');
  const hostRef = resolveGraphRef(String(process.env.COMPOSE));
  const subRef = resolveGraphRef(String(process.env.COMPOSE_WITH));
  const hostGraph = JSON.parse(fs.readFileSync(hostRef.file, 'utf8')) as ProcessGraph;
  const subGraph = JSON.parse(fs.readFileSync(subRef.file, 'utf8')) as ProcessGraph;

  const after = process.env.COMPOSE_AFTER;
  const r = composeGraphs(hostGraph, subGraph, {
    ref: subRef.ref,
    ...(after ? { after } : {}),
  });
  fs.writeFileSync(hostRef.file, JSON.stringify(r.graph, null, 2) + '\n');

  console.log(`✔ '${subRef.ref}' composed into '${hostRef.ref}' (${hostRef.file}):`);
  for (const line of r.summary) console.log(`  · ${line}`);
  console.log(`next:  GRILLME=${hostRef.ref} npm run grillme   ·   open it in the planner (check panel shows any new gaps)`);
});
