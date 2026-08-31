/**
 * R6 — multi-actor stitch: one recording per persona, one journey out.
 *
 * Each trace's action times are process-monotonic and NOT comparable across
 * recordings; the reader exposes the wall-clock anchor (wallTimeMs −
 * monotonicMs) so steps convert to absolute wall time and interleave in the
 * order the humans actually acted (design doc §7.1: "the distiller stitches
 * them on the shared records").
 *
 * Shared record ids appearing in more than one recording are the cross-actor
 * joints (the expense the submitter created is the one the approver touched);
 * v1 surfaces them as flags for {ref:} unification at binding time rather than
 * rewriting silently (parameterization stance: distiller__parameterization_rules).
 */

import type { Distillation } from './distill';

export interface RecordingInput {
  /** Actor alias in the stitched journey (lower_snake_case). */
  alias: string;
  /** personas.json id this recording was captured as. */
  persona: string;
  distillation: Distillation;
  /** TraceData.wallTimeMs − TraceData.monotonicMs for that recording. */
  wallOffsetMs: number;
}

export interface Stitched {
  actors: Record<string, string>;
  distillation: Distillation;
}

const ALIAS_RE = /^[a-z][a-z0-9_]*$/;

export function stitchRecordings(inputs: RecordingInput[]): Stitched {
  if (inputs.length === 0) throw new Error('stitch: no recordings given');
  const errors: string[] = [];
  const actors: Record<string, string> = {};
  for (const input of inputs) {
    if (!ALIAS_RE.test(input.alias)) errors.push(`alias '${input.alias}' must be lower_snake_case`);
    if (actors[input.alias]) errors.push(`duplicate alias '${input.alias}'`);
    if (!input.persona) errors.push(`alias '${input.alias}': persona required`);
    actors[input.alias] = input.persona;
    if (!Number.isFinite(input.wallOffsetMs)) {
      errors.push(`alias '${input.alias}': wallOffsetMs missing — regenerate the recording (older trace?)`);
    }
  }
  if (errors.length) throw new Error(`stitch inputs invalid:\n - ${errors.join('\n - ')}`);

  const steps = inputs.flatMap((input) =>
    input.distillation.steps.map((s) => ({
      ...s,
      actorAlias: input.alias,
      startMs: s.startMs + input.wallOffsetMs,
      endMs: s.endMs + input.wallOffsetMs,
    })),
  );
  steps.sort((a, b) => a.startMs - b.startMs);

  const harvestedIds = inputs.flatMap((input) =>
    input.distillation.harvestedIds.map((h) => ({ ...h, alias: input.alias })),
  );

  const flags = inputs.flatMap((input) => input.distillation.flags.map((f) => `[${input.alias}] ${f}`));

  // Cross-actor joints: same record id seen by more than one actor.
  const byId = new Map<string, Set<string>>();
  for (const h of harvestedIds) {
    if (!byId.has(h.id)) byId.set(h.id, new Set());
    byId.get(h.id)!.add(h.alias);
  }
  for (const [id, aliases] of byId) {
    if (aliases.size > 1) {
      flags.push(
        `cross-actor record id ${id} touched by [${[...aliases].join(', ')}] — this is the journey's shared record: unify as one {ref:} when binding`,
      );
    }
  }

  return {
    actors,
    distillation: { steps, harvestedIds, flags },
  };
}
