import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { SalesforceApi, buildPasswordTokenForm } from '../../src/api/salesforceApi';

test.describe('buildPasswordTokenForm', () => {
  test('appends security token to password when present', () => {
    const form = buildPasswordTokenForm({
      clientId: 'c', clientSecret: 's', username: 'u', password: 'p', securityToken: 'tok',
    });
    expect(form.password).toBe('ptok');
    expect(form.grant_type).toBe('password');
  });

  test('password unchanged without security token', () => {
    const form = buildPasswordTokenForm({ clientId: 'c', clientSecret: 's', username: 'u', password: 'p' });
    expect(form.password).toBe('p');
  });
});

test.describe('SalesforceApi', () => {
  interface Call { method: string; url: string }

  function stub(calls: Call[], createId = () => `id-${calls.length + 1}`) {
    return {
      post: async (url: string) => {
        calls.push({ method: 'POST', url });
        return { status: () => 201, ok: () => true, json: async () => ({ id: createId(), success: true }), text: async () => '' };
      },
      get: async (url: string) => {
        calls.push({ method: 'GET', url });
        return { ok: () => true, status: () => 200, json: async () => ({ records: [] }), text: async () => '' };
      },
      delete: async (url: string) => {
        calls.push({ method: 'DELETE', url });
        return { ok: () => true, status: () => 204 };
      },
    } as unknown as APIRequestContext;
  }

  test('URLs are versioned, trailing-slash safe, and SOQL-encoded', () => {
    const api = new SalesforceApi(stub([]), 'https://x.my.salesforce.com/', 't', 'v61.0');
    expect(api.sobjectUrl('Account')).toBe('https://x.my.salesforce.com/services/data/v61.0/sobjects/Account');
    expect(api.sobjectUrl('Account', '001x')).toContain('/sobjects/Account/001x');
    expect(api.queryUrl("SELECT Id FROM Account WHERE Name = 'A B'"))
      .toContain('query?q=SELECT%20Id%20FROM%20Account');
  });

  test('create tracks ids; deleteAll deletes children-first (reverse order)', async () => {
    const calls: Call[] = [];
    const api = new SalesforceApi(stub(calls), 'https://x.my.salesforce.com', 't');
    const accountId = await api.create('Account', { Name: 'A' });
    const contactId = await api.create('Contact', { LastName: 'B', AccountId: accountId });
    await api.deleteAll();

    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.url).toContain(`/Contact/${contactId}`); // child first
    expect(deletes[1]!.url).toContain(`/Account/${accountId}`);
  });

  test('deleteAll is idempotent (tracked list cleared)', async () => {
    const calls: Call[] = [];
    const api = new SalesforceApi(stub(calls), 'https://x.my.salesforce.com', 't');
    await api.create('Account', { Name: 'A' });
    await api.deleteAll();
    await api.deleteAll();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(1);
  });
});
