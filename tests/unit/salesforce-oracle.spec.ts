/**
 * SalesforceApi-backed ApiOracle binding — the emitted spec's persistence
 * assertions. Pins the contract: queries fenced to E2E_ test data (default:
 * THIS run's records via runId, so strays from earlier runs can never green
 * a check), injection-safe field/value/LIKE handling, unclaimable kinds
 * (db./log., INVALID_TYPE SObjects) surface as SKIPPED via OracleUnbound —
 * while real API errors still fail loudly.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  salesforceApiOracle, nameScopeClause, likeLiteral, E2E_NAME_SCOPE, type QueryApi,
} from '../../src/journeys/salesforceOracle';
import { evaluateOracles, OracleUnbound, type OracleSpec } from '../../src/journeys/oracles';
import { runId } from '../../src/utils/naming';

const NO_PAGE = undefined as unknown as Page;
const ctx = { args: {} };

function fakeApi(rows: unknown[] = [], failWith?: string): { soqls: string[]; api: QueryApi } {
  const soqls: string[] = [];
  return {
    soqls,
    api: {
      query: async <T,>(soql: string): Promise<T[]> => {
        soqls.push(soql);
        if (failWith) throw new Error(failWith);
        return rows as T[];
      },
    },
  };
}

const spec = (over: Partial<OracleSpec> = {}): OracleSpec => ({
  id: 'lead_created', kind: 'api.record_exists', target: 'Lead', ...over,
});

test.describe('scope fencing', () => {
  test('default scope is THIS run — the pattern embeds the process runId, wildcards escaped', () => {
    const clause = nameScopeClause('run');
    expect(clause).toBe(`Name LIKE '${likeLiteral(`E2E_${runId()}`)}%'`);
    expect(clause).toContain(runId().replace(/_/g, '\\_'));
    expect(clause).toContain("E2E\\_");
  });

  test('suite scope matches any E2E record (for literal-named captures)', async () => {
    expect(nameScopeClause('suite')).toBe(E2E_NAME_SCOPE);
    const { soqls, api } = fakeApi([]);
    await salesforceApiOracle(api, { scope: 'suite' })(spec(), ctx);
    expect(soqls[0]).toBe(`SELECT Id FROM Lead WHERE Name LIKE 'E2E\\_%' LIMIT 1`);
  });

  test('likeLiteral escapes every SOQL LIKE special', () => {
    expect(likeLiteral("a_b%c'd\\e")).toBe("a\\_b\\%c\\'d\\\\e");
    expect(likeLiteral('plain')).toBe('plain');
  });
});

test.describe('api.record_exists', () => {
  test('probes the SObject fenced to run-scoped E2E_ data by default', async () => {
    const { soqls, api } = fakeApi([{ Id: '00Q000000000001' }]);
    await expect(salesforceApiOracle(api)(spec(), ctx)).resolves.toBe(true);
    expect(soqls).toEqual([`SELECT Id FROM Lead WHERE ${nameScopeClause('run')} LIMIT 1`]);
  });

  test('absent record answers false — the poller retries, this binding does not', async () => {
    const { api } = fakeApi([]);
    await expect(salesforceApiOracle(api)(spec(), ctx)).resolves.toBe(false);
  });

  test('an invalid SObject target throws loudly (not unbound)', async () => {
    const { api } = fakeApi();
    const bad = spec({ target: 'Lead; DROP TABLE' });
    await expect(salesforceApiOracle(api)(bad, ctx)).rejects.toThrow(/not a valid SObject name/);
    await expect(salesforceApiOracle(api)(bad, ctx)).rejects.not.toBeInstanceOf(OracleUnbound);
  });
});

test.describe('api.field_equals', () => {
  const fieldSpec = (value: string): OracleSpec =>
    spec({ id: 'lead_potential', kind: 'api.field_equals', value });

  test('parses Field=Value into an escaped, run-scoped SOQL clause', async () => {
    const { soqls, api } = fakeApi([{ Id: 'x' }]);
    await expect(salesforceApiOracle(api)(fieldSpec('Status=Potential'), ctx)).resolves.toBe(true);
    expect(soqls[0]).toBe(`SELECT Id FROM Lead WHERE ${nameScopeClause('run')} AND Status = 'Potential' LIMIT 1`);
  });

  test("splits on the FIRST '=' — later ones belong to the value, quotes are escaped", async () => {
    const { soqls, api } = fakeApi([]);
    await salesforceApiOracle(api)(fieldSpec("Notes__c=a=b'c"), ctx);
    expect(soqls[0]).toContain("Notes__c = 'a=b\\'c'");
  });

  test('booleans and numbers go unquoted; strings stay quoted', async () => {
    const { soqls, api } = fakeApi([]);
    const oracle = salesforceApiOracle(api);
    await oracle(fieldSpec('IsConverted=TRUE'), ctx);
    await oracle(fieldSpec('NumberOfEmployees=42'), ctx);
    await oracle(fieldSpec('Rating=1st Class'), ctx);
    expect(soqls[0]).toContain('IsConverted = true');
    expect(soqls[1]).toContain('NumberOfEmployees = 42');
    expect(soqls[2]).toContain("Rating = '1st Class'");
  });

  test('malformed value and injection-shaped field names throw loudly', async () => {
    const { api } = fakeApi();
    const oracle = salesforceApiOracle(api);
    await expect(oracle(fieldSpec('no_equals_here'), ctx)).rejects.toThrow(/must be "Field=Value"/);
    await expect(oracle(fieldSpec("Status' OR ''='=x"), ctx)).rejects.toThrow(/not a valid field name/);
  });
});

test.describe('unclaimable kinds surface as SKIPPED through evaluateOracles', () => {
  test('db.query / log.traffic are not claimed — skipped with the reason', async () => {
    const { api } = fakeApi();
    const results = await evaluateOracles(
      NO_PAGE,
      [
        spec({ id: 'traffic', kind: 'log.traffic', target: 'log_gateway', value: 'create_customer_v2' }),
        spec({ id: 'row', kind: 'db.query', target: 'db_siebel', value: 'SELECT 1' }),
      ],
      ctx,
      salesforceApiOracle(api),
    );
    expect(results.map((r) => r.status)).toEqual(['skipped', 'skipped']);
    expect(results[0]!.message).toContain('no adapter bound for log.traffic');
  });

  test("an SObject the org doesn't know (INVALID_TYPE) is unbound-skipped, naming the other-system suspicion", async () => {
    const { api } = fakeApi([], "query failed: 400 [{\"errorCode\":\"INVALID_TYPE\"}]");
    const [r] = await evaluateOracles(NO_PAGE, [spec({ id: 'in_siebel', target: 'Customer' })], ctx, salesforceApiOracle(api));
    expect(r!.status).toBe('skipped');
    expect(r!.message).toContain("SObject 'Customer' is not known to this org");
    expect(r!.message).toContain('Siebel');
  });

  test('every other API error still FAILS loudly (expired token, bad field)', async () => {
    const { api } = fakeApi([], 'query failed: 401 INVALID_SESSION_ID');
    const [r] = await evaluateOracles(NO_PAGE, [spec()], ctx, salesforceApiOracle(api));
    expect(r!.status).toBe('fail');
    expect(r!.message).toContain('INVALID_SESSION_ID');
  });
});
