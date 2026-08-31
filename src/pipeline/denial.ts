/**
 * R5 — denial evidence extraction (design doc §7.3: denials stay AUTHORED,
 * but recording as the WRONG persona captures the refusal so the deny step
 * and its probe stub write themselves).
 *
 * Two evidence shapes a wrong-persona recording can contain:
 *  - api-refusal: a 4xx/5xx on the aura / services_data families (the server
 *    said no — the strongest signal, feeds the API half of the probe)
 *  - ui-blocked: an action that FAILED (strict-mode zero matches, timeout on
 *    a control that never rendered) — the UI half: the capability simply is
 *    not there for that persona
 * A wrong-persona recording containing NEITHER is a captured SUCCESS — the
 * generator refuses to emit a deny step from it (test-enforced), because that
 * would encode a security hole as an expectation.
 */

import type { RawEvent } from './traceReader';
import { networkFamily } from './distill';
import { compact } from '../utils/compact';

export type DenialEvidence =
  | { kind: 'api-refusal'; status: number; method: string; url: string }
  | { kind: 'ui-blocked'; api: string; selector?: string; message: string };

export function extractDenialEvidence(events: RawEvent[]): DenialEvidence[] {
  const evidence: DenialEvidence[] = [];
  for (const e of events) {
    if (e.kind === 'network') {
      const family = networkFamily(e.url);
      if ((family === 'aura' || family === 'services_data') && (e.status ?? 0) >= 400) {
        evidence.push({ kind: 'api-refusal', status: e.status!, method: e.method, url: e.url });
      }
    } else if (e.kind === 'action' && e.error) {
      evidence.push(compact({ kind: 'ui-blocked', api: e.api, selector: e.selector, message: e.error }));
    }
  }
  return evidence;
}

export function summarizeEvidence(evidence: DenialEvidence[]): string {
  return evidence
    .map((ev) =>
      ev.kind === 'api-refusal'
        ? `API refused: ${ev.method} ${ev.url} → ${ev.status}`
        : `UI blocked: ${ev.api} on ${ev.selector ?? '(no selector)'} — ${ev.message}`,
    )
    .join('; ');
}
