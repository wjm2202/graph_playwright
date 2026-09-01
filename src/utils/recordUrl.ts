/**
 * Lightning record-page URL grammar — the one place a Salesforce record id
 * is read out of a URL. Shared by the recorder (distill: harvest ids from a
 * capture), the runner (auto-publish the record a `produces` step landed on)
 * and slice replay.
 */

/** /lightning/r/<SObject>/<15|18-char id>/view */
export const RECORD_URL_RE = /\/lightning\/r\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})\/view/;

/** A bare Salesforce id (15 or 18 chars). */
export const SF_ID_RE = /\b([a-zA-Z0-9]{18}|[a-zA-Z0-9]{15})\b/;

export interface RecordRef {
  sobject: string;
  id: string;
}

/** The record a URL points at, or undefined when it is not a record page. */
export function recordFromUrl(url: string): RecordRef | undefined {
  const m = RECORD_URL_RE.exec(url);
  if (!m) return undefined;
  return { sobject: m[1] ?? '', id: m[2] ?? '' };
}
