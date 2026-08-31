/**
 * S17 — text from unknown values (trace args, JSON payloads) WITHOUT the
 * '[object Object]' trap no-base-to-string guards against: primitives print
 * naturally, objects print as JSON.
 */
export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- stringify returns undefined for functions/symbols
    return JSON.stringify(v) ?? '';
  } catch {
    return '[unprintable]';
  }
}
