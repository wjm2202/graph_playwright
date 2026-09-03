/**
 * S2 — replay a SLICE of a generated journey through the vocabulary catalog.
 *
 * Capture-first graphs collapse many captured micro-steps (fills, clicks,
 * saves) into one human-named does edge ('lead.create'). The composite step
 * module the emitter writes calls this: it loads the generated journey JSON
 * and replays exactly the recorded micro-steps behind that edge, with
 * placeholders resolved by the same resolver the runner uses — so captures
 * stay re-runnable forever and the graph stays human-sized.
 */
import * as fs from 'fs';
import * as path from 'path';
import { resolvePlaceholders, type RefMap } from '../data/seed';
import type { StepCatalog, StepCtx } from './catalog';

export async function runJourneySlice(
  ctx: StepCtx,
  vocab: StepCatalog,
  journeyFile: string,
  indexes: number[],
): Promise<void> {
  if (!fs.existsSync(journeyFile)) {
    throw new Error(
      `journey file missing: ${journeyFile} — run the pipeline for this capture first (sfpw pipeline <id>)`,
    );
  }
  const journey = JSON.parse(fs.readFileSync(journeyFile, 'utf8')) as { steps?: Record<string, unknown>[] };
  const steps = journey.steps ?? [];
  for (const i of indexes) {
    const s = steps[i];
    const name = s && typeof s.do === 'string' ? (s.do) : undefined;
    if (!name) {
      throw new Error(`slice index ${i} of ${path.basename(journeyFile)} is not a 'do' step — regenerate the graph after re-running the pipeline`);
    }
    const args = resolveArgs((s?.with as Record<string, unknown> | undefined) ?? {}, ctx.refs);
    await vocab.step(name)({ ...ctx, args, expects: {}, stepIndex: i });
  }
}

function resolveArgs(obj: Record<string, unknown>, refs: RefMap): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = resolvePlaceholders(v, refs);
  return out;
}
