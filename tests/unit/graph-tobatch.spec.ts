/**
 * PG-4 — graph → substrate batch: atom shapes, stripping rules (no dataURLs,
 * no positions, no notes in payloads), the payload cap, and a full validator
 * pass alongside the real hand-authored batches.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { toBatch, writeBatch, PAYLOAD_MAX } from '../../src/graph/toBatch';
import { goodGraph } from '../helpers/sampleGraph';

const REPO = path.resolve(__dirname, '../..');

test('emits graph + coverage atoms with hub edges and a derived_from link', () => {
  const b = toBatch(goodGraph());
  expect(b.atoms.map((a) => a.atom)).toEqual([
    'v1.procedure.process_expense_to_siebel__graph',
    'v1.fact.process_expense_to_siebel__coverage',
  ]);
  expect(b.edges).toEqual([
    { type: 'member_of', source: 'v1.procedure.process_expense_to_siebel__graph', target: 'v1.other.hub_sf_journeys' },
    { type: 'member_of', source: 'v1.fact.process_expense_to_siebel__coverage', target: 'v1.other.hub_sf_journeys' },
    { type: 'derived_from', source: 'v1.fact.process_expense_to_siebel__coverage', target: 'v1.procedure.process_expense_to_siebel__graph' },
  ]);
  const parsed = JSON.parse(b.atoms[0]!.payload) as { nodes: unknown[]; edges: unknown[] };
  expect(parsed.nodes).toHaveLength(5);
  expect(parsed.edges).toHaveLength(5);
});

test('coverage payload names systems, policies, actors, denials, records', () => {
  const b = toBatch(goodGraph());
  const cov = b.atoms[1]!.payload;
  expect(cov).toContain('siebel(siebel, max 1 session)');
  expect(cov).toContain('submitter→sales_user');
  expect(cov).toContain('denials probed: expense.approve');
  expect(cov).toContain('shared records: a03xx0000012AbCDEF');
  expect(cov).toContain('plan not captured');
});

test('payloads strip snapshots (dataURLs), positions, and notes', () => {
  const g = goodGraph();
  g.nodes[2]!.snapshot = { status: 'captured', ref: 'data:image/png;base64,AAAA', capturedAt: 'x' };
  g.nodes[2]!.pos = { x: 100, y: 200 };
  g.nodes[2]!.notes = 'private scribbles';
  const b = toBatch(g);
  expect(b.atoms[0]!.payload).not.toContain('data:image');
  expect(b.atoms[0]!.payload).not.toContain('"pos"');
  expect(b.atoms[0]!.payload).not.toContain('private scribbles');
  expect(b.atoms[0]!.payload).toContain('"snapshot":{"status":"captured"}');
  expect(b.atoms[0]!.payload).not.toContain('\n'); // single-line contract
});

test('oversize graphs are refused with splitting advice, not truncated', () => {
  const g = goodGraph();
  for (let i = 0; i < 60; i++) {
    g.nodes.push({
      id: `pad_${i}`, type: 'action', label: `Padding step ${i} with a fairly long label to inflate payload`,
      system: 'sf', actor: 'approver', notes: 'x',
    });
  }
  expect(() => toBatch(g)).toThrow(new RegExp(`> ${PAYLOAD_MAX} payload cap.*split the process`));
});

test('an invalid graph never becomes a batch', () => {
  const g = goodGraph();
  g.edges.push({ id: 'x', from: 'submit', to: 'ghost', type: 'next' });
  expect(() => toBatch(g)).toThrow(/graph invalid/);
});

test('written batch passes the real validator next to batches 01-10', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-'));
  try {
    for (const f of fs.readdirSync(path.join(REPO, 'L2', 'encoding'))) {
      if (/^batch-\d+\.json$/.test(f)) fs.copyFileSync(path.join(REPO, 'L2', 'encoding', f), path.join(scratch, f));
    }
    const file = writeBatch(goodGraph(), scratch);
    expect(path.basename(file)).toBe('batch-graph-expense-to-siebel.json');
    const out = execFileSync('node', [path.join(REPO, 'L2', 'encoding', 'validate.mjs'), scratch], { encoding: 'utf8' });
    expect(out).toContain('RESULT: publishable');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
