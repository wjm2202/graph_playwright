/**
 * CI config guards. A workflow that never triggers fails silently and
 * indefinitely — this repo shipped five commits with zero workflow runs
 * because the push trigger named a branch that didn't exist. Nothing in the
 * suite noticed, because nothing was looking. Now something is.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const WORKFLOW = path.join(ROOT, '.github/workflows/ci.yml');
const ci = () => fs.readFileSync(WORKFLOW, 'utf8');

/** Branches named under `on: push:` — the list that decides if CI ever runs. */
function pushBranches(src: string): string[] {
  const m = /on:\s*[\s\S]*?push:\s*[\s\S]*?branches:\s*\[([^\]]*)\]/.exec(src);
  if (!m) return [];
  return m[1]!.split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}

/** The branch this working copy is on, or undefined when detached (CI does
 *  this on pull_request runs — then the check simply doesn't apply). */
function currentBranch(): string | undefined {
  const head = path.join(ROOT, '.git/HEAD');
  if (!fs.existsSync(head)) return undefined;
  const m = /^ref: refs\/heads\/(.+)$/m.exec(fs.readFileSync(head, 'utf8').trim());
  return m?.[1];
}

test.describe('ci workflow triggers', () => {
  test('the push trigger covers the branch this repo is actually on', () => {
    const branch = currentBranch();
    test.skip(!branch, 'detached HEAD (a PR checkout) — nothing local to compare against');
    expect(
      pushBranches(ci()),
      `ci.yml push trigger does not include '${branch}' — pushes to it will run NO checks`,
    ).toContain(branch);
  });

  test('both main and master are covered, so a rename cannot kill CI', () => {
    const branches = pushBranches(ci());
    expect(branches).toContain('main');
    expect(branches).toContain('master');
  });

  test('pull requests trigger CI with no branch filter', () => {
    // A filtered pull_request trigger would break the required status check
    // the branch ruleset waits on.
    expect(ci()).toMatch(/pull_request:\s*(\n\s*\n)?\njobs:|pull_request:\s*\njobs:/);
  });
});

test.describe('ci workflow content', () => {
  test('runs the same three gates CONTRIBUTING.md demands', () => {
    const src = ci();
    expect(src).toContain('npm run typecheck');
    expect(src).toContain('npm run lint');
    // The suite runs unit + harness (+ record), matching `npm test`'s intent.
    expect(src).toMatch(/playwright test .*--project=unit .*--project=harness/);
  });

  test('needs no secrets — the suite is green with no org', () => {
    const src = ci();
    expect(src).not.toMatch(/\$\{\{\s*secrets\./);
  });

  test('the required status check name matches the job id the ruleset waits on', () => {
    // GitHub names the check after the job (no `name:` override), and the
    // branch ruleset requires exactly this string. If you rename the job,
    // rename it in the ruleset too or every PR blocks forever.
    expect(ci()).toMatch(/^jobs:\s*\n\s{2}test:/m);
  });
});
