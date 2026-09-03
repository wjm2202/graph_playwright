/**
 * `sfpw contracts` — the MMPM settle-contract harvest, moved out of the
 * generator in sprint 4.4 (review §4 #9: a test framework should not write
 * to a memory substrate as a side effect of generating a journey).
 *
 * The atoms and edges are byte-for-byte what `generateArtifacts` used to
 * emit as artifact #4 — the test that pinned them moved here with the code,
 * validator run and all.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { batchFor, settleContracts } from '../../src/cli/contracts';
import { distill } from '../../src/pipeline/distill';
import { readTrace } from '../../src/pipeline/traceReader';
import { generateArtifacts } from '../../src/pipeline/generate';

const FIXTURE = path.resolve(__dirname, '../fixtures/trace-demo/trace.zip');
const REPO = path.resolve(__dirname, '../..');

const harvest = () => settleContracts(distill(readTrace(FIXTURE).events).steps, '2026-08-30');

test('one atom per capability that showed a settle signal, hub-edged', () => {
  const { atoms, edges } = harvest();
  expect(atoms).toHaveLength(1);
  expect(atoms[0]!.atom).toBe('v1.procedure.step_modal_save__settle_contract');
  expect(atoms[0]!.payload).toContain("capability 'modal.save'");
  expect(atoms[0]!.payload).toContain('POST to the aura URL family');
  expect(edges).toEqual([
    { type: 'member_of', source: 'v1.procedure.step_modal_save__settle_contract', target: 'v1.other.hub_sf_waits' },
    { type: 'references', source: 'v1.procedure.step_modal_save__settle_contract', target: 'v1.procedure.aura_response_wait__surgical_pattern' },
  ]);
});

test('the emitted batch is validator-clean beside the real hand-authored ones', () => {
  const { atoms, edges } = harvest();
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'val-'));
  try {
    for (const f of fs.readdirSync(path.join(REPO, 'L2', 'encoding'))) {
      if (/^batch-\d+\.json$/.test(f)) fs.copyFileSync(path.join(REPO, 'L2', 'encoding', f), path.join(scratch, f));
    }
    fs.writeFileSync(
      path.join(scratch, 'batch-rec-fixture-demo.json'),
      JSON.stringify(batchFor('fixture_demo', atoms, edges), null, 2) + '\n',
    );
    const out = execFileSync('node', [path.join(REPO, 'L2', 'encoding', 'validate.mjs'), scratch], { encoding: 'utf8' });
    expect(out).toContain('RESULT: publishable');
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('the batch says REVIEW BEFORE PUBLISHING — nothing here checkpoints', () => {
  const doc = batchFor('fixture_demo', [], []) as { batch: string; description: string };
  expect(doc.batch).toBe('rec-fixture_demo');
  expect(doc.description).toContain('REVIEW BEFORE PUBLISHING');
});

test('generating a journey no longer writes an encoding batch anywhere', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-nc-'));
  try {
    const result = generateArtifacts(distill(readTrace(FIXTURE).events), {
      journeyId: 'fixture_demo',
      persona: 'sales_user',
      personaIds: ['admin', 'sales_user', 'portal_user', 'guest'],
      outDirs: {
        journeys: path.join(root, 'journeys'),
        stubs: path.join(root, 'stubs'),
        baselines: path.join(root, 'baselines'),
      },
      today: '2026-08-30',
    });
    expect(Object.keys(result)).not.toContain('batchFile');
    const written: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full); else written.push(full);
      }
    };
    walk(root);
    expect(written.filter((f) => f.includes('batch-rec-'))).toEqual([]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
