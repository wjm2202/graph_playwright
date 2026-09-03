import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { ANSWER_OPS, GAP_KINDS, HINT_KINDS, computeGaps } from '../../src/graph/gaps';

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
      // Script names may carry digits and colons (`ado:import`, `project:new`)
      // — without them the regex truncates the name and reports a script
      // package.json "lacks".
      [...README.matchAll(/npm run ([a-z][a-z0-9:]*)/g)].map((m) => m[1]!),
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

  test('the gap-kind count claim matches the gap engine', () => {
    // GAP_KINDS is the source of truth (the spec drift test pins it against
    // the docs, and gaps.spec pins its length) — not a number typed in prose.
    // Kinds emitted as HINTS are deliberately excluded: they are not gaps.
    const claimed = /\((\d+) gap kinds\)/.exec(README)?.[1];
    expect(claimed, 'README no longer states a gap-kind count').toBeTruthy();
    expect(GAP_KINDS.length).toBe(Number(claimed));
    // The engine's own source must not have drifted from the exported list.
    const src = fs.readFileSync(path.join(ROOT, 'src/graph/gaps.ts'), 'utf8');
    const emitted = new Set([...src.matchAll(/kind: '([a-z_]+)'/g)].map((m) => m[1]!));
    for (const k of emitted) {
      expect([...GAP_KINDS, ...HINT_KINDS] as string[], `${k} is emitted but listed nowhere`).toContain(k);
    }
    // computeGaps is the exported entry point the claim is about.
    expect(typeof computeGaps).toBe('function');
  });

  test('the write-back-operation count claim matches the AnswerOp union', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/graph/gaps.ts'), 'utf8');
    const ops = new Set([...src.matchAll(/\{ op: '(\w+)'/g)].map((m) => m[1]!));
    const claimed = /(\d+)\s+validated write-back operations/.exec(README)?.[1];
    expect(claimed, 'README no longer states an op count').toBeTruthy();
    expect(ops.size).toBe(Number(claimed));
    expect([...ops].sort()).toEqual([...ANSWER_OPS].sort());
  });

  test('it still carries the Status section (honesty is a feature)', () => {
    expect(README).toContain('## Status');
    // The two claims most likely to mislead an adopter must stay marked.
    expect(README).toMatch(/Real-org binding\s*\|\s*\*\*Pending\*\*/);
    expect(README).toMatch(/Unmeasured targets/);
  });
});
