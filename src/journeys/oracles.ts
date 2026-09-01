/**
 * Central oracle evaluation (DESIGN-EXPECTATIONS.md §3, automated).
 *
 * The runner calls this after EVERY does step and for every assert.* step —
 * no catalog entry required. ui.* kinds are fully automatic Playwright
 * web-first assertions; api.* kinds evaluate through one seam (`apiOracle`)
 * when provided — SalesforceApi.findOne makes the default binding trivial —
 * and are reported 'skipped' (never silently passed) when they cannot run.
 */

import { expect, type Page } from '@playwright/test';

export interface OracleSpec {
  id: string;
  kind: string;
  target?: string;
  value?: string;
  note?: string;
  /** Overrides the 10s default. api.* kinds POLL until this deadline. */
  timeoutMs?: number;
  /** api.* poll interval (default 1000ms, floor 100). */
  pollMs?: number;
}

export interface OracleResult {
  id: string;
  kind: string;
  status: 'pass' | 'fail' | 'skipped';
  message?: string;
}

export interface OracleContext {
  /** Journey-level args of the step the oracles ride on (record refs etc). */
  args: Record<string, unknown>;
  /** The seeding/query API when the runner has one. */
  api?: unknown;
}

/** The api.* seam: return true/false, or throw with a precise message. */
export type ApiOracle = (spec: OracleSpec, ctx: OracleContext) => Promise<boolean>;

/**
 * Thrown by an ApiOracle binding for kinds it cannot claim (no adapter for a
 * db/log system, an SObject that lives outside this org). Reported as
 * 'skipped' with the reason — visible, never a silent pass, and never a
 * run-failing fail for a check that CANNOT be evaluated here.
 */
export class OracleUnbound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleUnbound';
  }
}

const ORACLE_TIMEOUT = 10_000;

function timeoutFor(spec: OracleSpec): number {
  return spec.timeoutMs && spec.timeoutMs > 0 ? spec.timeoutMs : ORACLE_TIMEOUT;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * api.* kinds poll: a false return is retried until the deadline (async
 * integrations — SF→Siebel replication — settle in their own time). A THROWN
 * error is a deliberate, precise failure and stops the polling immediately.
 */
async function pollApiOracle(spec: OracleSpec, ctx: OracleContext, apiOracle: ApiOracle): Promise<OracleResult> {
  const timeout = timeoutFor(spec);
  const poll = Math.max(100, spec.pollMs ?? 1000);
  const started = Date.now();
  const deadline = started + timeout;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    if (await apiOracle(spec, ctx)) return pass(spec);
    if (Date.now() + poll > deadline) break;
    await sleep(poll);
  }
  const waited = ((Date.now() - started) / 1000).toFixed(1);
  return {
    id: spec.id, kind: spec.kind, status: 'fail',
    message: `${spec.kind} '${spec.target ?? ''}' did not hold${spec.value ? ` (${spec.value})` : ''}`
      + ` after ${waited}s (${attempts} ${attempts === 1 ? 'check' : 'checks'}${attempts > 1 ? `, every ${poll}ms` : ''})`,
  };
}

export async function evaluateOracles(
  page: Page,
  specs: OracleSpec[],
  ctx: OracleContext,
  apiOracle?: ApiOracle,
): Promise<OracleResult[]> {
  const results: OracleResult[] = [];
  for (const spec of specs) {
    const timeout = timeoutFor(spec);
    try {
      switch (spec.kind) {
        case 'ui.visible':
          await expect(page.getByText(spec.target ?? '', { exact: false }).first()).toBeVisible({ timeout });
          results.push(pass(spec));
          break;
        case 'ui.text':
          await expect(page.getByText(spec.value ?? '', { exact: false }).first()).toBeVisible({ timeout });
          results.push(pass(spec));
          break;
        case 'ui.toast':
          await expect(
            page.locator('.slds-notify_toast, [role="alert"], [role="status"]').filter({ hasText: spec.value ?? '' }).first(),
          ).toBeVisible({ timeout });
          results.push(pass(spec));
          break;
        case 'ui.url':
          await expect(page).toHaveURL(new RegExp(escapeRegExp(spec.value ?? '')), { timeout });
          results.push(pass(spec));
          break;
        case 'api.record_exists':
        case 'api.field_equals':
        case 'db.query':      // spec.target = db node id, spec.value = query
        case 'log.traffic':   // spec.target = logger node id, spec.value = search
          if (!apiOracle) {
            results.push({
              id: spec.id, kind: spec.kind, status: 'skipped',
              message: 'backend oracle not bound — provide deps.apiOracle (SalesforceApi.findOne for api.*; a DB/log adapter for db.query/log.traffic)',
            });
          } else {
            results.push(await pollApiOracle(spec, ctx, apiOracle));
          }
          break;
        default:
          results.push({ id: spec.id, kind: spec.kind, status: 'skipped', message: `unknown oracle kind '${spec.kind}'` });
      }
    } catch (e) {
      if (e instanceof OracleUnbound) {
        results.push({ id: spec.id, kind: spec.kind, status: 'skipped', message: trim(e.message) });
      } else {
        results.push({ id: spec.id, kind: spec.kind, status: 'fail', message: trim((e as Error).message) });
      }
    }
  }
  return results;
}

function pass(spec: OracleSpec): OracleResult {
  return { id: spec.id, kind: spec.kind, status: 'pass' };
}

function trim(message: string): string {
  return message.split('\n').slice(0, 3).join(' ').slice(0, 300);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
