/**
 * R7 — pipeline planning (pure): given the manifests found under
 * recordings/<journey>/, decide HOW to generate — single-actor, stitched
 * multi-actor, or deny mode — and surface config problems before any work.
 *
 * Env contract (the pipeline spec wires this):
 *   PIPELINE_JOURNEY   required — recordings/<journey>/ to process
 *   PIPELINE_ALIASES   optional — "submitter=sales_user,approver=admin"
 *                      (defaults: alias = persona id)
 *   PIPELINE_CAPABILITY  required when the recording set is a denial capture
 */

import type { RecordingManifest } from './recording';

export interface FoundRecording {
  dir: string;
  manifest: RecordingManifest;
}

export type PipelinePlan =
  | { mode: 'single'; journeyId: string; recording: FoundRecording; alias: string }
  | { mode: 'stitch'; journeyId: string; recordings: (FoundRecording & { alias: string })[] }
  | { mode: 'deny'; journeyId: string; recording: FoundRecording; alias: string; capability: string };

export function parseAliases(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {};
  if (!raw?.trim()) return map;
  for (const pair of raw.split(',')) {
    const [alias, persona] = pair.split('=').map((s) => s.trim());
    if (!alias || !persona) throw new Error(`PIPELINE_ALIASES entry '${pair}' must be alias=persona`);
    if (map[alias]) throw new Error(`PIPELINE_ALIASES duplicate alias '${alias}'`);
    map[alias] = persona;
  }
  return map;
}

export function planPipeline(
  journeyId: string,
  found: FoundRecording[],
  env: { aliases?: string | undefined; capability?: string | undefined } = {},
): PipelinePlan {
  if (found.length === 0) {
    throw new Error(`no recordings under recordings/${journeyId}/ — run \`npm run record\` first`);
  }

  const denials = found.filter((f) => f.manifest.expectDenial);
  const normals = found.filter((f) => !f.manifest.expectDenial);
  if (denials.length && normals.length) {
    throw new Error(
      `recordings/${journeyId}/ mixes denial captures with normal recordings — record denials under their own journey id (e.g. ${journeyId}_denied)`,
    );
  }
  if (denials.length > 1) {
    throw new Error(`recordings/${journeyId}/ has ${denials.length} denial captures — one deny step per journey id`);
  }

  const aliasMap = parseAliases(env.aliases);
  const aliasFor = (persona: string): string => {
    const explicit = Object.entries(aliasMap).find(([, p]) => p === persona)?.[0];
    return explicit ?? persona;
  };

  if (denials.length === 1) {
    const capability = env.capability?.trim();
    if (!capability) {
      throw new Error('denial capture found — set PIPELINE_CAPABILITY (e.g. expense.approve) to name what was refused');
    }
    const recording = denials[0]!; // this branch runs only when denials.length > 0
    return { mode: 'deny', journeyId, recording, alias: aliasFor(recording.manifest.persona), capability };
  }

  // Latest recording per persona wins (re-records supersede earlier takes).
  const byPersona = new Map<string, FoundRecording>();
  for (const f of [...normals].sort((a, b) => a.manifest.startedAt.localeCompare(b.manifest.startedAt))) {
    byPersona.set(f.manifest.persona, f);
  }
  const picked = [...byPersona.values()];

  if (picked.length === 1) {
    const only = picked[0]!;
    return { mode: 'single', journeyId, recording: only, alias: aliasFor(only.manifest.persona) };
  }
  return {
    mode: 'stitch',
    journeyId,
    recordings: picked.map((r) => ({ ...r, alias: aliasFor(r.manifest.persona) })),
  };
}
