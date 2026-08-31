/**
 * S15 — exactOptionalPropertyTypes helper: build an object literal with
 * possibly-undefined values, then DROP the undefined entries so the result
 * satisfies `prop?: T` (absent ≠ explicitly-undefined under the flag).
 */
/** The type after dropping undefined: always-undefined keys vanish, the rest lose `| undefined`. */
export type Compacted<T> = {
  [K in keyof T as [Exclude<T[K], undefined>] extends [never] ? never : K]: Exclude<T[K], undefined>;
};

export function compact<const T extends object>(obj: T): Compacted<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  // The cast is sound by construction: we only ever REMOVE undefined values,
  // exactly what Compacted<T> states. (comment required per the
  // unknown-at-the-boundary rule — this is the one blessed assertion here)
  return out as Compacted<T>;
}
