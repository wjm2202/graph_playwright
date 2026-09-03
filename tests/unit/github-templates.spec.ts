/**
 * GitHub templates are config that never runs locally — a broken issue form
 * fails silently on github.com, weeks after the commit. These tests are the
 * only thing standing between a typo and a form nobody can submit.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const gh = (p: string) => path.join(ROOT, '.github', p);
const read = (p: string) => fs.readFileSync(gh(p), 'utf8');

const FORMS = ['ISSUE_TEMPLATE/bug_report.yml', 'ISSUE_TEMPLATE/feature_request.yml'];

test.describe('pull request template', () => {
  const pr = () => read('pull_request_template.md');

  test('exists and states the three gates by their real command names', () => {
    const body = pr();
    for (const cmd of ['npm run typecheck', 'npm run lint', 'npm test']) {
      expect(body, `PR template must name ${cmd}`).toContain(cmd);
    }
  });

  test('every gate it names is a real package.json script', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const named = new Set([...pr().matchAll(/npm run ([a-z][a-z:]*)/g)].map((m) => m[1]!));
    expect([...named].filter((s) => !(s in pkg.scripts))).toEqual([]);
  });

  test('carries the DCO sign-off reminder CONTRIBUTING.md requires', () => {
    expect(read('pull_request_template.md')).toContain('git commit -s');
    expect(fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8')).toContain('git commit -s');
  });

  test('reminds contributors about secrets and the planner rebuild', () => {
    const body = pr();
    expect(body).toContain('personas.json');
    expect(body).toContain('npm run build:planner');
  });
});

test.describe('issue forms', () => {
  for (const form of FORMS) {
    test(`${form} is well-formed enough for GitHub to render`, () => {
      const body = read(form);
      // GitHub requires name, description and a body list of typed elements.
      expect(body).toMatch(/^name: .+/m);
      expect(body).toMatch(/^description: .+/m);
      expect(body).toMatch(/^body:/m);

      const types = [...body.matchAll(/- type: (\w+)/g)].map((m) => m[1]!);
      expect(types.length).toBeGreaterThan(0);
      const allowed = ['markdown', 'input', 'textarea', 'dropdown', 'checkboxes'];
      expect(types.filter((t) => !allowed.includes(t))).toEqual([]);

      // Every non-markdown element needs an id GitHub can key answers on.
      const blocks = body.split(/(?=  - type: )/).filter((b) => b.includes('- type: '));
      for (const block of blocks) {
        if (block.includes('- type: markdown')) continue;
        expect(block, `an element in ${form} has no id`).toMatch(/id: \w+/);
      }
    });

    test(`${form} indents consistently (the silent YAML killer)`, () => {
      for (const [i, line] of read(form).split('\n').entries()) {
        expect(line.includes('\t'), `${form}:${i + 1} contains a tab`).toBe(false);
      }
    });
  }

  test('bug report demands the no-secrets confirmation', () => {
    const body = read('ISSUE_TEMPLATE/bug_report.yml');
    expect(body).toContain('no credentials');
    // Required, not merely suggested.
    expect(body).toMatch(/no credentials[\s\S]*?required: true/);
  });

  test('bug report points at doctor rather than inviting an .env paste', () => {
    expect(read('ISSUE_TEMPLATE/bug_report.yml')).toContain('sfpw doctor');
  });

  test('blank issues are off, so the forms actually get used', () => {
    expect(read('ISSUE_TEMPLATE/config.yml')).toContain('blank_issues_enabled: false');
  });

  test('contact links point at this repo, not a template placeholder', () => {
    const cfg = read('ISSUE_TEMPLATE/config.yml');
    const urls = [...cfg.matchAll(/url: (\S+)/g)].map((m) => m[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) {
      expect(u).toContain('wjm2202/graph_playwright');
      expect(u).toMatch(/^https:\/\/github\.com\//);
    }
  });
});
