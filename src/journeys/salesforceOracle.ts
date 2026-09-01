/**
 * SalesforceApi-backed ApiOracle binding — the emitted spec's persistence
 * assertions (DESIGN-EXPECTATIONS api.* seam).
 *
 * Claims api.record_exists / api.field_equals via SOQL, scoped to run data by
 * the repo-wide naming convention (utils/naming.uniqueName; the sweeper purges
 * by the same marker, so the scope can never touch real data). Two scopes:
 *
 *  - 'run' (default): Name LIKE 'E2E_<runId>%' — only records THIS process
 *    created. Immune to strays left by earlier crashed runs, which would
 *    otherwise make record_exists pass before this run saved anything.
 *    Requires captured create-steps to name records through {unique:} /
 *    uniqueName (the repo's collision-safety rule anyway) — and note WHICH
 *    field SOQL sees as Name: a Lead's Name is First+Last (prefix the LAST
 *    name), a converted Account's Name is the lead's COMPANY.
 *  - 'suite': Name LIKE 'E2E\_%' — any E2E record. For captures that typed a
 *    literal E2E_ name during recording (not yet parameterized). Emitted
 *    specs select it via ORACLE_SCOPE=suite.
 *
 * NOT claimed — thrown as OracleUnbound so the runner reports 'skipped'
 * (visible, never a silent pass, never a false fail):
 *  - db.query / log.traffic — those need a real DB/log adapter;
 *  - an SObject this org doesn't know (INVALID_TYPE — e.g. a checkpoint whose
 *    record actually lives in Siebel).
 * Every OTHER API error (bad field, expired token, network) throws through —
 * a misconfigured oracle must fail loudly, not skip quietly.
 */

import { escapeSoql, type SalesforceApi } from '../api/salesforceApi';
import { OracleUnbound, type ApiOracle, type OracleSpec } from './oracles';
import { runId } from '../utils/naming';

const SOBJECT_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export type OracleScope = 'run' | 'suite';

export interface SalesforceOracleOptions {
  /** Which records count as "ours" — see the header. Default 'run'. */
  scope?: OracleScope;
}

/** Escape a literal for use inside a SOQL LIKE pattern: quotes/backslashes
 *  per string rules, and the LIKE wildcards `_`/`%` as literals. */
export function likeLiteral(value: string): string {
  const map: Record<string, string> = { '\\': '\\\\', "'": "\\'", _: '\\_', '%': '\\%' };
  return value.replace(/[\\'_%]/g, (c) => map[c] ?? c);
}

/** The WHERE clause fencing queries to this suite's (or this run's) data. */
export function nameScopeClause(scope: OracleScope): string {
  const prefix = scope === 'run' ? `E2E_${runId()}` : 'E2E_';
  return `Name LIKE '${likeLiteral(prefix)}%'`;
}

/** Suite-wide scope clause (exported for tests and diagnostics). */
export const E2E_NAME_SCOPE = "Name LIKE 'E2E\\_%'";

/** The api half of the seam only needs query(); tests fake exactly that. */
export type QueryApi = Pick<SalesforceApi, 'query'>;

export function salesforceApiOracle(api: QueryApi, opts: SalesforceOracleOptions = {}): ApiOracle {
  const scope = opts.scope ?? 'run';
  return async (spec) => {
    switch (spec.kind) {
      case 'api.record_exists':
        return exists(api, spec, scope);
      case 'api.field_equals':
        return exists(api, spec, scope, fieldEqualsClause(spec));
      default:
        throw new OracleUnbound(
          `no adapter bound for ${spec.kind} — the SalesforceApi oracle claims api.* only; ` +
            `wire a DB/log adapter to evaluate '${spec.target ?? spec.id}'`,
        );
    }
  };
}

async function exists(api: QueryApi, spec: OracleSpec, scope: OracleScope, extraClause?: string): Promise<boolean> {
  const sobject = spec.target ?? '';
  if (!SOBJECT_RE.test(sobject)) {
    throw new Error(`${spec.kind} '${spec.id}': target '${sobject}' is not a valid SObject name`);
  }
  const where = [nameScopeClause(scope), ...(extraClause ? [extraClause] : [])].join(' AND ');
  const soql = `SELECT Id FROM ${sobject} WHERE ${where} LIMIT 1`;
  try {
    const rows = await api.query<{ Id: string }>(soql);
    return rows.length > 0;
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes('INVALID_TYPE')) {
      throw new OracleUnbound(
        `SObject '${sobject}' is not known to this org (INVALID_TYPE) — if this record lives in ` +
          `another system (Siebel?), bind that system's adapter instead`,
      );
    }
    throw e;
  }
}

/** "Field=Value" (first '=' splits; later '=' belong to the value). */
function fieldEqualsClause(spec: OracleSpec): string {
  const raw = spec.value ?? '';
  const at = raw.indexOf('=');
  if (at < 1) {
    throw new Error(`api.field_equals '${spec.id}': value must be "Field=Value", got "${raw}"`);
  }
  const field = raw.slice(0, at).trim();
  const value = raw.slice(at + 1).trim();
  if (!FIELD_RE.test(field)) {
    throw new Error(`api.field_equals '${spec.id}': '${field}' is not a valid field name`);
  }
  return `${field} = ${soqlLiteral(value)}`;
}

/** Booleans and plain numbers go unquoted in SOQL; everything else is a
 *  quoted, escaped string. */
function soqlLiteral(value: string): string {
  if (/^(true|false)$/i.test(value)) return value.toLowerCase();
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  return `'${escapeSoql(value)}'`;
}
