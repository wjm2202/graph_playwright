/**
 * R0 — baselines lifecycle: window math, merge semantics, pruning, file IO,
 * and the runner-facing contract (p95 feeds gradeDuration unchanged).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  p95, mean, emptyBaselines, updateBaselines,
  loadBaselinesFile, saveBaselinesFile, baselinesPathFor,
  DEFAULT_WINDOW_SIZE, type StoredBaselines,
} from '../../src/journeys/baselines';
import { gradeDuration, type JourneyReport, type StepReport } from '../../src/journeys/runner';

function report(journey: string, steps: (Partial<StepReport> & { name: string })[]): JourneyReport {
  return {
    journey,
    flags: [],
    steps: steps.map((s, i) => ({
      index: s.index ?? i,
      kind: s.kind ?? 'do',
      actorAlias: s.actorAlias ?? 'actor',
      personaId: s.personaId ?? 'persona',
      name: s.name,
      ms: s.ms ?? 100,
      status: s.status ?? 'ok',
    })),
  };
}

test.describe('window math', () => {
  test('p95 nearest-rank: small windows behave sanely', () => {
    expect(p95([])).toBe(0);
    expect(p95([500])).toBe(500);
    expect(p95([100, 200])).toBe(200);
    // 20 samples → rank ceil(19) = 19th of 20 sorted
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(p95(twenty)).toBe(1900);
  });

  test('mean rounds to whole ms', () => {
    expect(mean([100, 101])).toBe(101);
    expect(mean([])).toBe(0);
  });
});

test.describe('updateBaselines', () => {
  test('first green run creates entries with n=1 and window=[ms]', () => {
    const next = updateBaselines(
      emptyBaselines('j'),
      report('j', [{ name: 'a.one', ms: 1200, actorAlias: 'sub', index: 0 }]),
      { today: '2026-08-30' },
    );
    expect(next.steps['0:sub/a.one']).toEqual({
      n: 1, samples: [1200], meanMs: 1200, p95Ms: 1200, updated: '2026-08-30',
    });
  });

  test('rolling window caps at windowSize, keeping the newest samples', () => {
    let doc = emptyBaselines('j', 3);
    for (const ms of [100, 200, 300, 400]) {
      doc = updateBaselines(doc, report('j', [{ name: 's', ms, index: 0, actorAlias: 'a' }]), { today: 'd' });
    }
    const entry = doc.steps['0:a/s'];
    expect(entry!.samples).toEqual([200, 300, 400]); // oldest (100) evicted
    expect(entry!.n).toBe(4); // lifetime count keeps growing
    expect(entry!.p95Ms).toBe(400);
    expect(entry!.meanMs).toBe(300);
  });

  test('deny steps never enter baselines (probes, not performance surface)', () => {
    const next = updateBaselines(
      emptyBaselines('j'),
      report('j', [
        { name: 'a.one', ms: 100, index: 0 },
        { name: 'expense.approve', kind: 'deny', ms: 50, index: 1 },
      ]),
    );
    expect(Object.keys(next.steps)).toEqual(['0:actor/a.one']);
  });

  test('pruning drops keys absent from the report by default; prune:false keeps them', () => {
    let doc = emptyBaselines('j');
    doc = updateBaselines(doc, report('j', [{ name: 'old.step', index: 0 }]));
    const edited = report('j', [{ name: 'new.step', index: 0 }]);

    const pruned = updateBaselines(doc, edited);
    expect(Object.keys(pruned.steps)).toEqual(['0:actor/new.step']);

    const kept = updateBaselines(doc, edited, { prune: false });
    expect(Object.keys(kept.steps).sort()).toEqual(['0:actor/new.step', '0:actor/old.step']);
  });

  test('journey mismatch is a hard error — one file per journey', () => {
    expect(() => updateBaselines(emptyBaselines('a'), report('b', [{ name: 's' }]))).toThrow(
      /baselines are for journey 'a' but the report is 'b'/,
    );
  });

  test('budgets survive updates untouched', () => {
    const doc: StoredBaselines = { ...emptyBaselines('j'), budgets: { softFactor: 2, hardFactor: 4 } };
    const next = updateBaselines(doc, report('j', [{ name: 's' }]));
    expect(next.budgets).toEqual({ softFactor: 2, hardFactor: 4 });
  });

  test('what we store is what the runner grades with', () => {
    let doc = emptyBaselines('j');
    for (const ms of [1000, 1000, 1000, 1000]) {
      doc = updateBaselines(doc, report('j', [{ name: 's', ms, index: 0, actorAlias: 'a' }]));
    }
    const b = doc.steps['0:a/s'];
    expect(gradeDuration(1400, b)).toBe('ok');     // ≤ p95×1.5
    expect(gradeDuration(1501, b)).toBe('soft');
    expect(gradeDuration(3001, b)).toBe('hard');
  });
});

test.describe('file IO', () => {
  test('round-trip with stable, numeric-aware key order; absent file → empty doc', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baselines-'));
    const file = path.join(dir, 'j.baselines.json');

    expect(loadBaselinesFile(file, 'j')).toEqual(emptyBaselines('j'));

    let doc = emptyBaselines('j');
    doc = updateBaselines(doc, report('j', [
      { name: 'z.last', index: 10, actorAlias: 'a' },
      { name: 'a.first', index: 2, actorAlias: 'a' },
    ]), { today: 'd' });
    saveBaselinesFile(file, doc);

    const text = fs.readFileSync(file, 'utf8');
    expect(text.indexOf('"2:a/a.first"')).toBeLessThan(text.indexOf('"10:a/z.last"'));
    expect(loadBaselinesFile(file, 'j').steps['2:a/a.first']!.n).toBe(1);

    expect(() => loadBaselinesFile(file, 'other')).toThrow(/is for 'j', expected 'other'/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('conventional path + default window constant', () => {
    expect(baselinesPathFor('expense_sod')).toBe(path.join('journeys', 'baselines', 'expense_sod.baselines.json'));
    expect(DEFAULT_WINDOW_SIZE).toBe(20);
  });
});
