import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { computeGaps } from '../../src/graph/gaps';

/**
 * README drift guard. The README makes checkable claims about this repo —
 * commands you can run, files you can open, counts we quote. Docs rot
 * silently; this makes them rot loudly instead.
 */

const ROOT = path.resolve(__dirname, '../..');
const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test.describe('README', () => {
  test('every `npm run <script>` it names exists in package.json', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const scripts = new Set(Object.keys(pkg.scripts));

    const referenced = new Set(
      [...README.matchAll(/npm run ([a-z][a-z:]*)/g)].map((m) => m[1]!),
    );
    expect(referenced.size).toBeGreaterThan(0);

    const missing = [...referenced].filter((s) => !scripts.has(s));
    expect(missing, `README names scripts package.json lacks`).toEqual([]);
  });

  test('every relative link it makes resolves to a real file', () => {
    const links = [...README.matchAll(/\]\(([^)]+)\)/g)]
      .map((m) => m[1]!)
      .filter((l) => !/^(https?:|#|mailto:)/.test(l));
    expect(links.length).toBeGreaterThan(0);

    const broken = links.filter((l) => !fs.existsSync(path.join(ROOT, l)));
    expect(broken, 'README links to files that do not exist').toEqual([]);
  });

  test('the "9 gap kinds" claim matches the gap engine', () => {
    // The engine's kinds are the union it can ever emit; read them from the
    // source of truth rather than trusting a number typed into prose.
    const src = fs.readFileSync(
      path.join(ROOT, 'src/graph/gaps.ts'),
      'utf8',
    );
    const kinds = new Set(
      [...src.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!),
    );
    const claimed = /\((\d+) gap kinds\)/.exec(README)?.[1];
    expect(claimed, 'README no longer states a gap-kind count').toBeTruthy();
    expect(kinds.size).toBe(Number(claimed));
    // computeGaps is the exported entry point the claim is about.
    expect(typeof computeGaps).toBe('function');
  });

  test('the "8 write-back operations" claim matches the AnswerOp union', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/graph/gaps.ts'), 'utf8');
    const ops = new Set([...src.matchAll(/\{ op: '(\w+)'/g)].map((m) => m[1]!));
    const claimed = /(\d+)\s+validated write-back operations/.exec(README)?.[1];
    expect(claimed, 'README no longer states an op count').toBeTruthy();
    expect(ops.size).toBe(Number(claimed));
  });

  test('it still carries the Status section (honesty is a feature)', () => {
    expect(README).toContain('## Status');
    // The two claims most likely to mislead an adopter must stay marked.
    expect(README).toMatch(/Real-org binding\s*\|\s*\*\*Pending\*\*/);
    expect(README).toMatch(/Unmeasured targets/);
  });
});
