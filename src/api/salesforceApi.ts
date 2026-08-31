/**
 * REST data layer via Playwright's APIRequestContext (founding doc §9.2).
 * Data via API, UI for behavior only. For richer needs (Bulk, Streaming,
 * Metadata) swap in jsforce v3 — this file keeps the starter dependency-free.
 *
 * Cleanup contract: track every created Id; deleteAll() in teardown, children
 * before parents. Records are named via utils/naming.uniqueName so a sweeper
 * can purge anything a crashed run left behind.
 */

import type { APIRequestContext } from '@playwright/test';

export interface TokenResponse {
  access_token: string;
  instance_url: string;
}

/** Form body for the OAuth username-password token grant (test contexts only). */
export function buildPasswordTokenForm(opts: {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  securityToken?: string;
}): Record<string, string> {
  return {
    grant_type: 'password',
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    username: opts.username,
    password: `${opts.password}${opts.securityToken ?? ''}`,
  };
}

/** Escape a value for use inside SOQL single quotes. */
export function escapeSoql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export class SalesforceApi {
  private readonly created: { sobject: string; id: string }[] = [];

  constructor(
    private readonly request: APIRequestContext,
    private readonly instanceUrl: string,
    private readonly accessToken: string,
    private readonly apiVersion = 'v61.0',
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  sobjectUrl(sobject: string, id?: string): string {
    const base = `${this.instanceUrl.replace(/\/+$/, '')}/services/data/${this.apiVersion}/sobjects/${sobject}`;
    return id ? `${base}/${id}` : base;
  }

  queryUrl(soql: string): string {
    return `${this.instanceUrl.replace(/\/+$/, '')}/services/data/${this.apiVersion}/query?q=${encodeURIComponent(soql)}`;
  }

  /** Create a record; the Id is tracked for teardown. */
  async create(sobject: string, fields: Record<string, unknown>): Promise<string> {
    const res = await this.request.post(this.sobjectUrl(sobject), {
      headers: this.headers(),
      data: fields,
    });
    if (res.status() !== 201) {
      throw new Error(`create ${sobject} failed: ${res.status()} ${await res.text()}`);
    }
    const body = (await res.json()) as { id: string; success: boolean };
    this.created.push({ sobject, id: body.id });
    return body.id;
  }

  /** Dual-layer assertion support: fetch persisted state to verify UI actions. */
  async retrieve<T = Record<string, unknown>>(sobject: string, id: string): Promise<T> {
    const res = await this.request.get(this.sobjectUrl(sobject, id), { headers: this.headers() });
    if (!res.ok()) throw new Error(`retrieve ${sobject}/${id} failed: ${res.status()}`);
    return (await res.json()) as T;
  }

  async query<T = Record<string, unknown>>(soql: string): Promise<T[]> {
    const res = await this.request.get(this.queryUrl(soql), { headers: this.headers() });
    if (!res.ok()) throw new Error(`query failed: ${res.status()} ${await res.text()}`);
    const body = (await res.json()) as { records: T[] };
    return body.records;
  }

  /**
   * Find-or-create support (seed engine `findBy`): first Id matching the
   * exact field values, or null. Values are SOQL-escaped.
   */
  async findOne(sobject: string, where: Record<string, unknown>): Promise<string | null> {
    const clauses = Object.entries(where).map(([f, v]) => `${f} = '${escapeSoql(String(v))}'`);
    if (!clauses.length) throw new Error('findOne needs at least one where field');
    const rows = await this.query<{ Id: string }>(
      `SELECT Id FROM ${sobject} WHERE ${clauses.join(' AND ')} LIMIT 1`,
    );
    return rows[0]?.Id ?? null;
  }

  async delete(sobject: string, id: string): Promise<void> {
    const res = await this.request.delete(this.sobjectUrl(sobject, id), { headers: this.headers() });
    // 404 = already gone: acceptable in teardown.
    if (!res.ok() && res.status() !== 404) {
      throw new Error(`delete ${sobject}/${id} failed: ${res.status()}`);
    }
  }

  /** Teardown: delete tracked records in reverse creation order (children first). */
  async deleteAll(): Promise<void> {
    for (const { sobject, id } of [...this.created].reverse()) {
      await this.delete(sobject, id);
    }
    this.created.length = 0;
  }
}
