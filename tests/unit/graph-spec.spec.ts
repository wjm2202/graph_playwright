/**
 * docs/GRAPH-SPEC.md is the normative contract an external author (human or
 * AI) works from. It must never fall behind the code: every node type, edge
 * type, expectation kind, port, origin, gap kind and write-back op the code
 * knows has to be named in the spec, the minimal example must validate and
 * be complete, and the skill that hands the spec to an AI must exist and
 * point at it.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
  DATA_IOS, DATA_ORIGINS, EDGE_TYPES, EXPECTATION_KINDS, NODE_TYPES, SYSTEM_KINDS, validateGraph, type ProcessGraph,
} from '../../src/graph/schema';
import { GAP_KINDS, GRILLME_OPS, computeGaps } from '../../src/graph/gaps';
import { chainHealth, dataflowHealth } from '../../src/graph/compose';
import { toJourney } from '../../src/graph/toJourney';

const SPEC = fs.readFileSync(path.resolve('docs/GRAPH-SPEC.md'), 'utf8');

test('every vocabulary item the code knows is named in the spec', () => {
  const missing: string[] = [];
  const mention = (group: string, items: readonly string[]) => {
    for (const item of items) if (!SPEC.includes(`\`${item}\``)) missing.push(`${group}: ${item}`);
  };
  mention('node type', NODE_TYPES);
  mention('edge type', EDGE_TYPES);
  mention('system kind', SYSTEM_KINDS);
  mention('expectation kind', EXPECTATION_KINDS);
  mention('port', DATA_IOS);
  mention('origin', DATA_ORIGINS);
  mention('gap kind', GAP_KINDS);
  mention('op', GRILLME_OPS);
  for (const auth of ['frontdoor', 'singleaccess', 'ui']) if (!SPEC.includes(auth)) missing.push(`auth: ${auth}`);
  expect(missing, 'add these to docs/GRAPH-SPEC.md').toEqual([]);
});

test('the spec\'s minimal graph validates, walks, and is complete except for capture', () => {
  const block = /## 11\. A complete minimal graph\s*```json\s*([\s\S]*?)```/.exec(SPEC);
  expect(block, 'section 11 must carry a ```json block').toBeTruthy();
  const g = JSON.parse(block![1]!) as ProcessGraph;
  expect(validateGraph(g)).toEqual({ ok: true, errors: [] });
  expect(chainHealth(g)).toEqual({ errors: [], stranded: [] });
  expect(dataflowHealth(g).errors).toEqual([]);
  const r = toJourney(g, { personaIds: ['admin'] });
  expect(r.journey.steps.map((s) => ('do' in s ? s.do : `deny:${s.deny.capability}`))).toEqual(['cust.create', 'deny:cust.delete']);
  const gaps = computeGaps(g, { knownPersonas: ['admin'] });
  expect(gaps.map((x) => x.kind)).toEqual(['not_captured']);
});

test('the graph-author skill exists in the repo and hands the spec + the commands to the AI', () => {
  const skill = fs.readFileSync(path.resolve('skills/graph-author/SKILL.md'), 'utf8');
  expect(skill).toMatch(/^---\nname: graph-author\n/);
  expect(skill).toContain('docs/GRAPH-SPEC.md');
  for (const cmd of ['npm run grillme', 'GRILLME_APPLY', 'npm run ado:import', 'npm run record', 'npm run graph:spec', 'GAPS_JSON']) {
    expect(skill, `skill must mention ${cmd}`).toContain(cmd);
  }
  for (const kind of GAP_KINDS) expect(skill, `skill must know gap kind ${kind}`).toContain(kind);
  // The skill must not teach the AI to bypass the validator or invent personas.
  expect(skill).toMatch(/never invent a persona/i);
});
