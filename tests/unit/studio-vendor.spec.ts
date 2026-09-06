import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * tools/studio is a vendored copy of journey-studio (tools/studio/VENDOR.md)
 * so this repo is standalone. This pins the shape that the rest of the repo
 * relies on — the CLI entry, the libraries the ingest path needs, the web
 * pages the planner deep-links to, the font the stitcher burns labels with,
 * the licence — and that the CLI actually runs from its new home.
 */
const ROOT = path.resolve(__dirname, '../..');
const STUDIO = path.join(ROOT, 'tools/studio');
const has = (p: string) => fs.existsSync(path.join(STUDIO, p));

test.describe('vendored journey-studio', () => {
  test('the files this repo depends on are present', () => {
    for (const p of [
      'bin/journey-studio.mjs',
      'lib/ingest.mjs',
      'lib/build-core.mjs',
      'lib/stitch.mjs',
      'lib/serve.mjs',
      'test/serve-mount.test.mjs',
      'lib/timeline.mjs',
      'web/dashboard.html',
      'web/studio.html',
      'web/feedback.html',
      'assets/font.ttf',
      'LICENSE',
      'VENDOR.md',
      'test/stitch.test.mjs',
    ]) {
      expect(has(p), `tools/studio/${p}`).toBe(true);
    }
  });

  test('zero runtime dependencies — nothing in tools/studio imports from node_modules', () => {
    const dirs = ['bin', 'lib'];
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of fs.readdirSync(path.join(STUDIO, d))) {
        if (!f.endsWith('.mjs')) continue;
        const src = fs.readFileSync(path.join(STUDIO, d, f), 'utf8');
        for (const m of src.matchAll(/^\s*import\b[^'"]*['"]([^'"]+)['"]/gm)) {
          const spec = m[1]!;
          if (!spec.startsWith('node:') && !spec.startsWith('.') && !spec.startsWith('/')) offenders.push(`${d}/${f} → ${spec}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the CLI runs from tools/studio and knows --no-open', () => {
    const out = execFileSync('node', [path.join(STUDIO, 'bin/journey-studio.mjs')], { encoding: 'utf8' });
    expect(out).toContain('journey-studio serve');
    expect(out).toContain('--no-open');
    const bin = fs.readFileSync(path.join(STUDIO, 'bin/journey-studio.mjs'), 'utf8');
    expect(bin).toContain("t === '--no-open'");
    expect(bin).toContain('if (!OPEN_BROWSER) return;');
  });

  test('the studio deep link the planner builds matches what the vendored page reads', () => {
    const page = fs.readFileSync(path.join(STUDIO, 'web/studio.html'), 'utf8');
    expect(page).toMatch(/q\.get\('slug'\)/);
    expect(page).toMatch(/q\.get\('batch'\)/);
    const dash = fs.readFileSync(path.join(STUDIO, 'web/dashboard.html'), 'utf8');
    expect(dash).toMatch(/q\.get\('batch'\)/);
  });

  test('the licence travels with the copy', () => {
    expect(fs.readFileSync(path.join(STUDIO, 'LICENSE'), 'utf8')).toContain('MIT License');
  });
});
