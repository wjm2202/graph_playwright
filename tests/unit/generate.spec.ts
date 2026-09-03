/**
 * R4 — generator: all three artifacts from the committed fixture recording,
 * schema validity, the networkidle ban and baselines via the R0 code path.
 *
 * The settle-contract batch is NOT one of them since sprint 4.4 — it moved
 * behind `sfpw contracts` (src/cli/contracts.ts, covered by
 * tests/unit/contracts.spec.ts), so generating a journey no longer writes to
 * a memory substrate as a side effect.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTrace } from '../../src/pipeline/traceReader';
import { distill, type Distillation } from '../../src/pipeline/distill';
import { generateArtifacts } from '../../src/pipeline/generate';
import { validateJourney } from '../../src/journeys/schema';

const FIXTURE = path.resolve(__dirname, '../fixtures/trace-demo/trace.zip');
const PERSONAS = ['admin', 'sales_user', 'portal_user', 'guest'];

function tmpDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-'));
  return {
    root,
    outDirs: {
      journeys: path.join(root, 'journeys'),
      stubs: path.join(root, 'stubs'),
      baselines: path.join(root, 'baselines'),
    },
  };
}

function fixtureGen(journeyId = 'fixture_demo') {
  const { root, outDirs } = tmpDirs();
  const d = distill(readTrace(FIXTURE).events);
  const result = generateArtifacts(d, {
    journeyId,
    persona: 'sales_user',
    personaIds: PERSONAS,
    outDirs,
    today: '2026-08-30',
  });
  return { root, result, d };
}

test('journey JSON: schema-valid, right steps, settle hint on the save', () => {
  const { root, result } = fixtureGen();
  try {
    const journey = JSON.parse(fs.readFileSync(result.journeyFile, 'utf8'));
    expect(validateJourney(journey, { personaIds: PERSONAS }).errors).toEqual([]);
    expect(journey.actors).toEqual({ main: 'sales_user' });
    expect(journey.steps.map((s: { do: string }) => s.do)).toEqual([
      'recordPage.open', 'form.fill', 'combobox.select', 'modal.save',
    ]);
    expect(journey.steps[1].with).toEqual({ label: 'Amount', value: '4999' });
    expect(journey.steps[3].with).toMatchObject({ button: 'Save', settle: 'aura' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('step implementations: real vocabulary code, no networkidle anywhere', () => {
  const { root, result } = fixtureGen();
  try {
    const stubs = fs.readFileSync(result.stubsFile, 'utf8');
    for (const reg of ["'recordPage.open'", "'form.fill'", "'combobox.select'", "'modal.save'"]) {
      expect(stubs).toContain(`.register(${reg}`);
    }
    expect(stubs).toContain('lightning.combobox(String(args.label)).select(String(args.option))');
    expect(stubs).toContain('lightning.auraResponse()');

    // The ban, checked across every emitted artifact:
    const all = [result.journeyFile, result.stubsFile, result.baselinesFile!]
      .map((f) => fs.readFileSync(f, 'utf8').replace(/networkidle is banned/g, ''))
      .join('');
    expect(all).not.toContain('networkidle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('baselines: n=1 windows through the R0 lifecycle, keys match runner grading', () => {
  const { root, result } = fixtureGen();
  try {
    const b = JSON.parse(fs.readFileSync(result.baselinesFile!, 'utf8'));
    expect(b.journey).toBe('fixture_demo');
    const keys = Object.keys(b.steps);
    expect(keys).toEqual([
      '0:main/recordPage.open', '1:main/form.fill', '2:main/combobox.select', '3:main/modal.save',
    ]);
    for (const k of keys) {
      expect(b.steps[k].n).toBe(1);
      expect(b.steps[k].samples).toHaveLength(1);
      expect(b.steps[k].p95Ms).toBe(b.steps[k].samples[0]);
    }
    // The save step's baseline includes the settle tail, not just the click ack:
    expect(b.steps['3:main/modal.save'].p95Ms).toBeGreaterThan(0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw steps: unique catalog names, loud throw-stubs, flags carried through', () => {
  const { root, outDirs } = tmpDirs();
  try {
    const d: Distillation = {
      steps: [
        { kind: 'raw', catalog: 'raw.name_me', args: { api: 'click', selector: 'div.x > span' }, startMs: 0, endMs: 5, durationMs: 5, recognized: false, sourceEvents: [0], flag: 'name-me' },
        { kind: 'raw', catalog: 'raw.name_me', args: { api: 'press', selector: 'div.y' }, startMs: 10, endMs: 15, durationMs: 5, recognized: false, sourceEvents: [1], flag: 'name-me' },
      ],
      harvestedIds: [],
      flags: ['step 0: unrecognized click on div.x > span — name it to grow the grammar'],
    };
    const result = generateArtifacts(d, { journeyId: 'raw_demo', persona: 'admin', personaIds: PERSONAS, outDirs, today: '2026-08-30' });

    const journey = JSON.parse(fs.readFileSync(result.journeyFile, 'utf8'));
    expect(journey.steps.map((s: { do: string }) => s.do)).toEqual(['raw.name_me_0', 'raw.name_me_1']);

    const stubs = fs.readFileSync(result.stubsFile, 'utf8');
    expect(stubs).toContain(".register('raw.name_me_0'");
    expect(stubs).toContain(".register('raw.name_me_1'");
    expect(stubs).toContain('name it in the grammar, then regenerate');

    expect(result.flags.join()).toContain('grow the grammar');
    expect(result.flags.join()).toContain('unnamed raw step');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown recording persona is a generator error, not a broken artifact', () => {
  const { root, outDirs } = tmpDirs();
  try {
    const d = distill(readTrace(FIXTURE).events);
    expect(() =>
      generateArtifacts(d, { journeyId: 'x', persona: 'ghost', personaIds: PERSONAS, outDirs }),
    ).toThrow(/unknown persona 'ghost'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
