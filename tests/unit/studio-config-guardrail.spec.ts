import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Journey Studio integration guardrail (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §3.1).
 *
 * Journey Studio can only review a run that left three things behind: a
 * Playwright JSON report, a video, and a full trace. All three are config,
 * and config drifts silently — nothing else in the suite fails when someone
 * trims the reporter list or turns video off "to speed things up". This
 * pins them, and pins the OTHER half of the deal: unit/harness/CI runs stay
 * lean, and `test-results/` + `studio/` never reach git.
 */
const ROOT = path.resolve(__dirname, '../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test.describe('journey studio — playwright.config.ts', () => {
  const cfg = read('playwright.config.ts');

  test('json reporter writes results.json inside test-results/', () => {
    expect(cfg).toMatch(/\['json',\s*\{\s*outputFile:\s*'test-results\/results\.json'\s*\}\]/);
  });

  test('list and html reporters are still there (humans and CI read those)', () => {
    expect(cfg).toContain("['list']");
    expect(cfg).toMatch(/\['html',\s*\{\s*open:\s*'never'\s*\}\]/);
  });

  test('video and full trace are on for the e2e project only, and off in CI', () => {
    const e2eStart = cfg.indexOf("name: 'e2e'");
    expect(e2eStart).toBeGreaterThan(0);
    const e2e = cfg.slice(e2eStart);
    expect(e2e).toMatch(/video:\s*process\.env\.CI\s*\?\s*'off'\s*:\s*'on'/);
    expect(e2e).toMatch(/trace:\s*process\.env\.CI\s*\?\s*'on-first-retry'\s*:\s*'on'/);
    // nothing before the e2e project block records video
    expect(cfg.slice(0, e2eStart)).not.toMatch(/\bvideo:/);
    // the top-level default stays lean
    expect(cfg.slice(0, e2eStart)).toMatch(/trace:\s*'on-first-retry'/);
  });

  test('test-results stays the default outputDir (Journey Studio rebases on that path segment)', () => {
    // the config KEY, not the word — comments may mention it
    expect(cfg).not.toMatch(/^\s*outputDir\s*:/m);
  });
});

test.describe('journey studio — repo plumbing', () => {
  test('.gitignore keeps run artifacts and the studio OUTPUT out of git — but not the vendored tool', () => {
    const lines = read('.gitignore').split('\n').map((l) => l.trim());
    for (const want of ['test-results/', 'playwright-report/', '/studio/']) {
      expect(lines, `${want} missing from .gitignore`).toContain(want);
    }
    // an unanchored `studio/` would also ignore tools/studio/ — the vendored copy
    expect(lines).not.toContain('studio/');
  });

  test('package.json scripts run the vendored studio: serve quietly, ingest without serving, test it', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.studio).toBe('node tools/studio/bin/journey-studio.mjs serve --dir studio/guides --no-open');
    expect(pkg.scripts['studio:ingest']).toBe(
      'node tools/studio/bin/journey-studio.mjs ingest --from test-results --out studio/guides --no-serve',
    );
    expect(pkg.scripts['test:studio']).toBe('node --test tools/studio/test/*.test.mjs');
  });

  test('.env.example documents the Journey Studio knobs', () => {
    const env = read('.env.example');
    for (const name of ['JOURNEY_STUDIO_OUT', 'JOURNEY_STUDIO_BIN']) {
      expect(env).toContain(`${name}=`);
    }
  });

  test('the session ladder builds every context from contextOptionsFor (else no video ever records)', () => {
    // Playwright never records manually created contexts; Cast passes
    // recordVideo itself, per persona, via contextOptionsFor. A newContext
    // call that spreads the shared options directly silently loses video.
    const cast = read('src/fixtures/cast.ts');
    expect(cast).not.toMatch(/newContext\(\s*\{?\s*\.\.\.cast\.contextOptions\b/);
    expect(cast).not.toMatch(/newContext\(cast\.contextOptions\)/);
    // code calls only (`browser.newContext(`), not the prose that explains them
    const calls = cast.match(/(?:await|return) browser\.newContext\(/g)?.length ?? 0;
    expect(calls).toBeGreaterThan(0);
    const viaCast = cast.match(/browser\.newContext\((?:\{\s*\.\.\.)?cast\.contextOptionsFor\(personaId\)/g)?.length ?? 0;
    expect(viaCast).toBe(calls);
    expect(cast).toMatch(/testInfo\.attach\('video'/);
  });

  test('graphs.spec.ts annotates every test and attaches the run report', () => {
    const spec = read('tests/e2e/graphs.spec.ts');
    expect(spec).toContain("from '../../src/studio/slug'");
    expect(spec).toMatch(/testInfo\.annotations\.push\(guideAnnotation\(ref,\s*variant,\s*graph\)\)/);
    expect(spec).toMatch(/testInfo\.attach\('graph-run'/);
  });
});
