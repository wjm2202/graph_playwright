/**
 * Data helpers — the "flawless re-run" layer: factory uniqueness by
 * construction, dictionary classification + placeholder rewriting, the
 * distiller's automatic parameterization of captured fills, find-or-create
 * seeding with owned-vs-found teardown semantics, and the sweeper's pure parts.
 */
import { test, expect } from '@playwright/test';
import { generate, uniqueTag, fakeSpecs } from '../../src/data/factory';
import { classify, loadDictionary, normalize, placeholderFor } from '../../src/data/dictionary';
import { seedRecords, resolvePlaceholders, type SeedApi } from '../../src/data/seed';
import { distill } from '../../src/pipeline/distill';
import { escapeSoql } from '../../src/api/salesforceApi';
import { buildSweepSoql, parseSweepPatterns, parseSweepTargets, DEFAULT_TARGETS } from '../../src/data/sweep';
import type { RawEvent } from '../../src/pipeline/traceReader';

test.describe('factory', () => {
  test('identity kinds carry a unique tag; two calls never collide', () => {
    const a = generate('person.lastName');
    const b = generate('person.lastName');
    expect(a).not.toBe(b);
    expect(a).toMatch(/ E2E-[a-z0-9]+-w\d+-\d+$/);
    expect(generate('company')).toMatch(/ E2E-/);
  });

  test('emails are unique, lowercase, and can never route anywhere real', () => {
    const a = generate('email');
    const b = generate('email');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[a-z0-9.-]+@e2e\.invalid$/);
    expect(a).toContain('e2e-');
  });

  test('realism-only kinds (phone) come untagged; unknown specs fail with the list', () => {
    expect(generate('phone')).not.toContain('E2E-');
    expect(() => generate('person.shoeSize')).toThrow(/unknown \{fake:person.shoeSize\}.*person\.lastName/);
    expect(fakeSpecs()).toContain('email');
  });

  test('uniqueTag encodes run, worker, and sequence', () => {
    expect(uniqueTag()).toMatch(/^E2E-[a-z0-9]+-w\d+-\d+$/);
  });
});

test.describe('dictionary', () => {
  const dict = loadDictionary();

  test('defaults + repo file merge; labels normalize (case, *, spacing)', () => {
    expect(normalize('  Last  Name *')).toBe('last name');
    expect(classify('Last Name', dict)).toMatchObject({ cls: 'identity', fake: 'person.lastName', source: 'dictionary' });
    expect(classify('Credit Status', dict)).toMatchObject({ cls: 'business', source: 'dictionary' }); // from data-dictionary.json
  });

  test('heuristics cover the unknowns and say so', () => {
    expect(classify('Email Address', dict)).toMatchObject({ cls: 'identity_email', source: 'heuristic' });
    expect(classify('Partner Company', dict)).toMatchObject({ cls: 'identity', fake: 'company', source: 'heuristic' });
    expect(classify('Deal Name', dict)).toMatchObject({ cls: 'identity', source: 'heuristic' });
    // 'Nickname' has no standalone word 'name' — correctly NOT an identity:
    expect(classify('Nickname', dict)).toMatchObject({ cls: 'business', source: 'heuristic' });
    expect(classify('Discount Percent', dict)).toMatchObject({ cls: 'business', source: 'heuristic' });
  });

  test('placeholders: email → fake:email, spec’d identity → fake, bare identity → unique, business → literal', () => {
    expect(placeholderFor('Email', classify('Email', dict))).toBe('{fake:email}');
    expect(placeholderFor('Last Name', classify('Last Name', dict))).toBe('{fake:person.lastName}');
    expect(placeholderFor('Deal Name', classify('Deal Name', dict))).toBe('{unique:deal_name}');
    expect(placeholderFor('Amount', classify('Amount', dict))).toBeUndefined();
  });
});

test.describe('distiller auto-parameterization', () => {
  const fill = (label: string, value: string, t: number): RawEvent =>
    ({ kind: 'action', api: 'fill', selector: `internal:label="${label}"i`, value, startMs: t, endMs: t + 10 });

  test('identity fills become generators, business fills keep their substance', () => {
    const d = distill([
      fill('Last Name', 'Smith', 0),
      fill('Company', 'Acme Ltd', 20),
      fill('Email', 'smith@acme.com', 40),
      fill('Amount', '4999', 60),
    ]);
    const values = d.steps.map((s) => s.args.value);
    expect(values[0]).toBe('{fake:person.lastName}');
    expect(values[1]).toBe('{fake:company}');
    expect(values[2]).toBe('{fake:email}');
    expect(values[3]).toBe('4999'); // the scenario keeps its numbers

    expect(d.flags.join()).toContain("data: 'Last Name' captured 'Smith' → {fake:person.lastName}");
    expect(d.flags.join()).not.toContain("'Amount' captured");
  });

  test('heuristic classifications carry the confirm-once nudge; placeholders are idempotent', () => {
    const d = distill([fill('Deal Name', 'Big Deal', 0), fill('Last Name', '{fake:person.lastName}', 20)]);
    expect(d.steps[0]!.args.value).toBe('{unique:deal_name}');
    expect(d.flags.join()).toContain('heuristic — confirm once in data-dictionary.json');
    expect(d.steps[1]!.args.value).toBe('{fake:person.lastName}'); // untouched, no double-wrap
  });

  test('the generated values resolve at run time into unique concrete data', () => {
    const resolved = resolvePlaceholders('{fake:person.lastName}', {});
    expect(String(resolved)).toMatch(/ E2E-/);
  });
});

test.describe('find-or-create seeding', () => {
  function apiWith(found: string | null) {
    const created: string[] = [];
    const lookups: Record<string, unknown>[] = [];
    const api: SeedApi = {
      async create(sobject) { created.push(sobject); return 'NEW1'; },
      async findOne(_s, where) { lookups.push(where); return found; },
    };
    return { api, created, lookups };
  }

  test('found: reuses the existing id, marks found, never creates (so never torn down)', async () => {
    const { api, created, lookups } = apiWith('EXIST1');
    const refs = await seedRecords(api, [
      { ref: 'acct', sobject: 'Account', findBy: ['Name'], fields: { Name: 'Globex', Industry: 'Energy' } },
    ]);
    expect(refs.acct).toMatchObject({ id: 'EXIST1', found: true });
    expect(created).toEqual([]);
    expect(lookups).toEqual([{ Name: 'Globex' }]); // matches on findBy fields only
  });

  test('missed: creates (tracked) and marks owned', async () => {
    const { api, created } = apiWith(null);
    const refs = await seedRecords(api, [
      { ref: 'acct', sobject: 'Account', findBy: ['Name'], fields: { Name: 'Globex' } },
    ]);
    expect(refs.acct).toMatchObject({ id: 'NEW1', found: false });
    expect(created).toEqual(['Account']);
  });

  test('misuse fails loudly: findBy without findOne, or naming a missing field', async () => {
    const bare: SeedApi = { async create() { return 'X'; } };
    await expect(
      seedRecords(bare, [{ ref: 'a', sobject: 'Account', findBy: ['Name'], fields: { Name: 'x' } }]),
    ).rejects.toThrow(/findBy but the api has no findOne/);

    const { api } = apiWith(null);
    await expect(
      seedRecords(api, [{ ref: 'a', sobject: 'Account', findBy: ['Website'], fields: { Name: 'x' } }]),
    ).rejects.toThrow(/findBy field 'Website' is not in fields/);
  });

  test('SOQL escaping defangs quotes and backslashes', () => {
    expect(escapeSoql("O'Brien \\ Co")).toBe("O\\'Brien \\\\ Co");
  });
});

test.describe('sweeper pure parts', () => {
  test('default targets are children-first; overrides parse and validate', () => {
    expect(DEFAULT_TARGETS[0]!.sobject).toBe('Case');
    expect(DEFAULT_TARGETS[DEFAULT_TARGETS.length - 1]!.sobject).toBe('Account');
    expect(parseSweepTargets('Lead:LastName, Account:Name')).toEqual([
      { sobject: 'Lead', field: 'LastName' },
      { sobject: 'Account', field: 'Name' },
    ]);
    expect(() => parseSweepTargets('Lead')).toThrow(/must be SObject:Field/);
  });

  test('patterns default to both naming conventions; SOQL is shaped and escaped', () => {
    expect(parseSweepPatterns(undefined)).toEqual(['E2E\\_%', '%E2E-%']);
    expect(buildSweepSoql({ sobject: 'Lead', field: 'Name' }, '%E2E-%')).toBe(
      "SELECT Id, Name FROM Lead WHERE Name LIKE '%E2E-%' LIMIT 200",
    );
    expect(buildSweepSoql({ sobject: 'Lead', field: 'Name' }, "E2E\\_%")).toContain("LIKE 'E2E\\\\_%'");
  });
});
