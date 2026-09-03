/**
 * `sfpw pipeline <journey> [--aliases a=b,…] [--capability x] [--graph] [--overwrite]`
 *
 * recordings/<journey>/ → generated artifacts. A thin shell over tested
 * pieces: readTrace → distill (→ stitch) → generate. Denial captures take
 * their evidence from the trace; a captured success refuses to generate.
 * Artifacts land in the real repo dirs for review. The MMPM settle-contract
 * batch is NOT one of them since sprint 4.4 — `sfpw contracts <journey>`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { emitCaptureGraph } from '../graph/fromCapture';
import { planPipeline, type FoundRecording } from '../pipeline/cli';
import { extractDenialEvidence } from '../pipeline/denial';
import { distill, type Distillation } from '../pipeline/distill';
import { generateArtifacts, type GenerateResult } from '../pipeline/generate';
import type { RecordingManifest } from '../pipeline/recording';
import { stitchRecordings } from '../pipeline/stitch';
import { readTrace } from '../pipeline/traceReader';
import { PersonaRegistry } from '../personas/registry';
import { recordEvent } from '../telemetry';
import { boolFlag, noExtraPositionals, parseArgs, stringFlag, UsageError, type Cli } from './args';

export const usage = `usage: sfpw pipeline <journey> [--aliases a=b,…] [--capability <cap>] [--graph] [--overwrite]

  <journey>            the folder under recordings/ to process
  --aliases a=b,c=d    role alias → persona ("submitter=sales_user")
  --capability <cap>   required for a denial capture: what was refused
  --graph              also emit a capture-first process graph
  --overwrite          let --graph replace an existing authored graph`;

function asFlags<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (!(e instanceof Error)) throw e;
    throw new Error(
      e.message.replace('PIPELINE_CAPABILITY', '--capability').replace('PIPELINE_ALIASES', '--aliases'),
    );
  }
}

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, {
    booleans: ['graph', 'overwrite'],
    strings: ['aliases', 'capability'],
  });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const journeyId = args.positionals[0];
  if (journeyId === undefined) throw new UsageError('pipeline needs a journey id', usage);
  noExtraPositionals(args, 1, 'pipeline', usage);

  const root = path.join(cli.cwd, 'recordings', journeyId);
  const found: FoundRecording[] = fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .map((d) => path.join(root, d))
        .filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
        .map((dir) => ({
          dir,
          manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RecordingManifest,
        }))
    : [];

  const aliases = stringFlag(args, 'aliases');
  const capability = stringFlag(args, 'capability');
  // planPipeline is shared with the recorder's own docs and still words its
  // refusals in the env names the pipeline spec used; say them as flags here
  // so the fix it names is the one you can type.
  const plan = asFlags(() =>
    planPipeline(journeyId, found, {
      ...(aliases !== undefined ? { aliases } : {}),
      ...(capability !== undefined ? { capability } : {}),
    }),
  );
  const personaIds = PersonaRegistry.load(path.join(cli.cwd, 'personas.json')).ids();

  let result: GenerateResult;
  let graphSource: { distillation: Distillation; actors: Record<string, string> } | undefined;
  if (plan.mode === 'deny') {
    const data = readTrace(path.join(plan.recording.dir, plan.recording.manifest.files.trace));
    result = generateArtifacts(distill(data.events), {
      journeyId,
      persona: plan.recording.manifest.persona,
      personaIds,
      deny: { capability: plan.capability, evidence: extractDenialEvidence(data.events) },
    });
  } else if (plan.mode === 'single') {
    const data = readTrace(path.join(plan.recording.dir, plan.recording.manifest.files.trace));
    const distillation = distill(data.events);
    result = generateArtifacts(distillation, {
      journeyId,
      persona: plan.recording.manifest.persona,
      personaIds,
    });
    graphSource = { distillation, actors: { main: plan.recording.manifest.persona } };
  } else {
    const stitched = stitchRecordings(
      plan.recordings.map((r) => {
        const data = readTrace(path.join(r.dir, r.manifest.files.trace));
        return {
          alias: r.alias,
          persona: r.manifest.persona,
          distillation: distill(data.events),
          wallOffsetMs: (data.wallTimeMs ?? 0) - (data.monotonicMs ?? 0),
        };
      }),
    );
    result = generateArtifacts(stitched.distillation, { journeyId, actors: stitched.actors, personaIds });
    graphSource = { distillation: stitched.distillation, actors: stitched.actors };
  }

  recordEvent({ kind: 'pipeline', id: journeyId });

  cli.out(`\n✔ pipeline (${plan.mode}) for '${journeyId}':`);
  cli.out(`  journey:   ${result.journeyFile}`);
  cli.out(`  steps:     ${result.stubsFile}`);
  if (result.baselinesFile) cli.out(`  baselines: ${result.baselinesFile}`);
  cli.out('  contracts: not written (sfpw contracts ' + journeyId + ' harvests the MMPM settle atoms on demand)');
  for (const flag of result.flags) cli.out(`  ⚑ ${flag}`);

  // Capture-first graph — on demand (D3), never silently over an authored graph.
  if (boolFlag(args, 'graph')) {
    if (!graphSource) {
      cli.out('  ⚑ --graph: denial captures do not emit graphs');
      return 0;
    }
    const existing = path.resolve(cli.cwd, 'journeys', 'graphs', `${journeyId}.graph.json`);
    const graphId = fs.existsSync(existing) && !boolFlag(args, 'overwrite') ? `${journeyId}_captured` : journeyId;
    if (graphId !== journeyId) {
      cli.out(`  ⚑ graph '${journeyId}' already exists — writing '${graphId}' (--overwrite to replace)`);
    }
    const emitted = emitCaptureGraph(graphSource.distillation, {
      graphId,
      journeyId,
      actors: graphSource.actors,
    });
    cli.out(`  graph:     ${emitted.graphFile}  (draft oracles — confirm in the planner)`);
    cli.out(`  composite: ${emitted.stepsFile}`);
    for (const flag of emitted.flags) cli.out(`  ⚑ ${flag}`);
  }
  return 0;
}
