/**
 * Seed engine: ordered creation, placeholder grammar, precise failures.
 */
import { test, expect } from '@playwright/test';
import { seedRecords, resolvePlaceholders, type RefMap, type SeedApi } from '../../src/data/seed';
import { runId } from '../../src/utils/naming';

function mockApi() {
  const calls: { sobject: string; fields: Record<string, unknown> }[] = [];
  let n = 0;
  const api: SeedApi = {
    async create(sobject, fields) {
      calls.push({ sobject, fields });
      n += 1;
      return `00Q${String(n).padStart(4, '0')}`;
    },
  };
  return { api, calls };
}

test('seeds in order and returns the ref map with created ids', async () => {
  const { api, calls } = mockApi();
  const refs = await seedRecords(api, [
    { ref: 'acct', sobject: 'Account', fields: { Name: '{unique:Acme}' } },
    { ref: 'opp', sobject: 'Opportunity', fields: { AccountId: '{ref:acct.id}', StageName: 'Prospecting' } },
  ]);

  expect(calls.map((c) => c.sobject)).toEqual(['Account', 'Opportunity']); // parent first
  expect(refs.acct!.id).toBe('00Q0001');
  expect(refs.opp!.id).toBe('00Q0002');
  expect(calls[1]!.fields.AccountId).toBe('00Q0001'); // child wired to parent id
});

test('{unique:} produces sweepable collision-safe names', async () => {
  const { api, calls } = mockApi();
  await seedRecords(api, [{ ref: 'a', sobject: 'Account', fields: { Name: '{unique:Acme}' } }]);
  expect(String(calls[0]!.fields.Name)).toMatch(new RegExp(`^E2E_${runId()}_Acme_\\d+$`));
});

test('bare {ref:x} and {ref:x.id} both mean the record id', async () => {
  const { api, calls } = mockApi();
  await seedRecords(api, [
    { ref: 'acct', sobject: 'Account', fields: { Name: 'A' } },
    { ref: 'c1', sobject: 'Contact', fields: { AccountId: '{ref:acct}' } },
    { ref: 'c2', sobject: 'Contact', fields: { AccountId: '{ref:acct.id}' } },
  ]);
  expect(calls[1]!.fields.AccountId).toBe('00Q0001');
  expect(calls[2]!.fields.AccountId).toBe('00Q0001');
});

test('{ref:x.Field} reads a resolved field value, preserving type on exact match', async () => {
  const { api, calls } = mockApi();
  await seedRecords(api, [
    { ref: 'exp', sobject: 'Expense__c', fields: { Amount__c: 4999 } },
    { ref: 'note', sobject: 'Note__c', fields: { Amount__c: '{ref:exp.Amount__c}', Body__c: 'copy of {ref:exp.Amount__c}' } },
  ]);
  expect(calls[1]!.fields.Amount__c).toBe(4999); // exact-match placeholder keeps number type
  expect(calls[1]!.fields.Body__c).toBe('copy of 4999'); // inline substitution stringifies
});

test('forward references fail with the refs seeded so far', async () => {
  const { api } = mockApi();
  await expect(
    seedRecords(api, [
      { ref: 'opp', sobject: 'Opportunity', fields: { AccountId: '{ref:acct.id}' } },
      { ref: 'acct', sobject: 'Account', fields: { Name: 'late' } },
    ]),
  ).rejects.toThrow(/unknown ref 'acct'.*forward references are invalid/);
});

test('unknown property names the available ones', async () => {
  const { api } = mockApi();
  await expect(
    seedRecords(api, [
      { ref: 'acct', sobject: 'Account', fields: { Name: 'A' } },
      { ref: 'opp', sobject: 'Opportunity', fields: { X: '{ref:acct.Phone}' } },
    ]),
  ).rejects.toThrow(/'Phone' not found on 'acct' — available: id, sobject, Name/);
});

test('duplicate refs are rejected', async () => {
  const { api } = mockApi();
  await expect(
    seedRecords(api, [
      { ref: 'a', sobject: 'Account', fields: {} },
      { ref: 'a', sobject: 'Account', fields: {} },
    ]),
  ).rejects.toThrow(/duplicate seed ref 'a'/);
});

test('resolvePlaceholders is reusable for step args (non-strings pass through)', () => {
  const refs: RefMap = {
    exp: { ref: 'exp', sobject: 'Expense__c', id: 'EXP1', fields: { Amount__c: 42 } },
  };
  expect(resolvePlaceholders('{ref:exp}', refs)).toBe('EXP1');
  expect(resolvePlaceholders(7, refs)).toBe(7);
  expect(resolvePlaceholders(true, refs)).toBe(true);
  expect(resolvePlaceholders('run {runId} ref {ref:exp.Amount__c}', refs)).toBe(
    `run ${runId()} ref 42`,
  );
});
