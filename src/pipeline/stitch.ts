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
 * joints (the expense the submitter created is the one the approver touched).
 * Since STUDY-DATA-FLOW.md they are UNIFIED here: the recording that created
 * the record owns its handle, every other actor's literal becomes
 * {ref:<handle>.id}, and handles that would collide across recordings are
 * numbered. Every rewrite is flagged; ids nobody created stay literal.
 */

import { renameHandle, type Distillation, type HarvestedId } from './distill';

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

  // Steps keep their provenance (input + index) until sorted, so the per-
  // recording def-use indexes can be re-pointed at the merged order.
  const tagged = inputs.flatMap((input, inputIdx) =>
    input.distillation.steps.map((s, idx) => ({
      inputIdx,
      idx,
      step: {
        ...s,
        args: { ...s.args },
        actorAlias: input.alias,
        startMs: s.startMs + input.wallOffsetMs,
        endMs: s.endMs + input.wallOffsetMs,
      },
    })),
  );
  tagged.sort((a, b) => a.step.startMs - b.step.startMs);
  const steps = tagged.map((t) => t.step);
  const mergedIndex = new Map<string, number>();
  tagged.forEach((t, i) => mergedIndex.set(`${t.inputIdx}:${t.idx}`, i));
  const stepsOf = (inputIdx: number) => tagged.filter((t) => t.inputIdx === inputIdx).map((t) => t.step);

  const flags = inputs.flatMap((input) => input.distillation.flags.map((f) => `[${input.alias}] ${f}`));

  // ---- dataflow unification across recordings (STUDY-DATA-FLOW.md §3.4) --
  // Each recording ran def-use alone. Now: one record id = one handle, and
  // two DIFFERENT records must not share a handle.
  const harvestedIds: (HarvestedId & { alias: string })[] = [];
  const handleOwner = new Map<string, string>(); // handle → record id
  const byId = new Map<string, (HarvestedId & { alias: string; inputIdx: number })[]>();
  inputs.forEach((input, inputIdx) => {
    for (const h of input.distillation.harvestedIds) {
      const entry = { ...h, alias: input.alias, inputIdx };
      if (!byId.has(h.id)) byId.set(h.id, []);
      byId.get(h.id)!.push(entry);
    }
  });
  for (const [id, entries] of byId) {
    const canonical = entries.find((e) => e.origin === 'step') ?? entries[0]!; // byId only holds non-empty lists
    let handle = canonical.handle;
    if (handle) {
      const base = handle;
      for (let n = 2; handleOwner.has(handle) && handleOwner.get(handle) !== id; n++) handle = `${base}_${n}`;
      if (handle !== base) {
        for (const e of entries) if (e.handle === base) for (const s of stepsOf(e.inputIdx)) renameHandle(s, base, handle);
        flags.push(`[${canonical.alias}] handle '${base}' already names another record — this ${canonical.sobject ?? 'record'} is '${handle}'`);
      }
      handleOwner.set(handle, id);
    }
    const useSteps = new Set<number>();
    for (const e of entries) {
      for (const i of e.useSteps ?? []) useSteps.add(mergedIndex.get(`${e.inputIdx}:${i}`)!);
      if (e === canonical || !handle) continue;
      // Another actor saw the record this one created: their literal (or
      // their own handle) becomes the canonical handle.
      for (const s of stepsOf(e.inputIdx)) {
        if (e.handle && e.handle !== handle) renameHandle(s, e.handle, handle);
        for (const [k, v] of Object.entries(s.args)) {
          if (typeof v === 'string' && v.includes(id) && canonical.origin === 'step') s.args[k] = v.split(id).join(`{ref:${handle}.id}`);
        }
      }
    }
    const aliases = [...new Set(entries.map((e) => e.alias))];
    if (aliases.length > 1) {
      flags.push(
        `cross-actor record ${id} touched by [${aliases.join(', ')}]` +
          (canonical.origin === 'step' && handle
            ? ` — created by ${canonical.alias}; every actor now resolves it as {ref:${handle}.id}`
            : ' — nobody in these recordings created it: seed it or find it by name'),
      );
    }
    const { inputIdx: _drop, ...rest } = canonical;
    void _drop;
    harvestedIds.push({
      ...rest,
      ...(handle ? { handle } : {}),
      ...(canonical.defStep !== undefined ? { defStep: mergedIndex.get(`${canonical.inputIdx}:${canonical.defStep}`)! } : {}),
      useSteps: [...useSteps].sort((a, b) => a - b),
    });
  }

  return {
    actors,
    distillation: { steps, harvestedIds, flags },
  };
}
