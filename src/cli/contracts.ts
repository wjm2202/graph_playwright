/**
 * `sfpw contracts <journey> [--out <dir>]` — the MMPM settle-contract batch,
 * on demand (sprint 4.4; review §4 #9).
 *
 * It used to be artifact #4 of every `sfpw pipeline` run: generating a
 * journey silently wrote `L2/encoding/batch-rec-<id>.json`, coupling a test
 * framework to a memory substrate nobody had asked about. The harvest itself
 * is worth keeping — a recording is the only place a real settle signal is
 * observed — so it moved here, behind its own verb, and runs only when asked.
 *
 * Nothing is ever published: the file is a REVIEW artifact. A human reads it
 * and checkpoints it (or does not).
 */
import * as fs from 'fs';
import * as path from 'path';
import { distill, type DistilledStep } from '../pipeline/distill';
import type { RecordingManifest } from '../pipeline/recording';
import { readTrace } from '../pipeline/traceReader';
import { noExtraPositionals, parseArgs, stringFlag, UsageError, type Cli } from './args';

export const usage = `usage: sfpw contracts <journey> [--out <dir>]

  <journey>       the folder under recordings/ to harvest
  --out <dir>     where to write the batch (default: L2/encoding)

Writes one review-only batch of MMPM settle-contract atoms harvested from the
recording's observed waits. Never published — read it, then checkpoint it
yourself.`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { strings: ['out'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const journeyId = args.positionals[0];
  if (journeyId === undefined) throw new UsageError('contracts needs a journey id', usage);
  noExtraPositionals(args, 1, 'contracts', usage);

  const root = path.join(cli.cwd, 'recordings', journeyId);
  const dirs = fs.existsSync(root)
    ? fs.readdirSync(root).map((d) => path.join(root, d)).filter((d) => fs.existsSync(path.join(d, 'manifest.json')))
    : [];
  if (!dirs.length) {
    cli.err(`no recordings under recordings/${journeyId}/ — capture one first (sfpw record <persona> ${journeyId})`);
    return 1;
  }

  const steps: DistilledStep[] = [];
  for (const dir of dirs) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as RecordingManifest;
    steps.push(...distill(readTrace(path.join(dir, manifest.files.trace)).events).steps);
  }

  const { atoms, edges } = settleContracts(steps, new Date().toISOString().slice(0, 10));
  if (!atoms.length) {
    cli.out(`no settle signals in recordings/${journeyId}/ — nothing to harvest`);
    return 0;
  }

  const outDir = path.resolve(cli.cwd, stringFlag(args, 'out') ?? path.join('L2', 'encoding'));
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `batch-rec-${journeyId.replace(/_/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(batchFor(journeyId, atoms, edges), null, 2) + '\n');

  cli.out(`✔ ${atoms.length} settle contract${atoms.length === 1 ? '' : 's'} → ${file}`);
  cli.out('  review it, then publish via a checkpoint yourself — this command never does.');
  return 0;
}

export interface ContractAtom { atom: string; payload: string }
export interface ContractEdge { type: string; source: string; target: string }

/** The batch document, shaped exactly as the pipeline used to emit it. */
export function batchFor(journeyId: string, atoms: ContractAtom[], edges: ContractEdge[]): unknown {
  return {
    batch: `rec-${journeyId}`,
    description:
      `Settle contracts harvested from the '${journeyId}' recording (pipeline v1). ` +
      'REVIEW BEFORE PUBLISHING — the pipeline never checkpoints directly.',
    atoms,
    edges,
  };
}

/** One contract atom per capability that showed a settle signal (deduped). */
export function settleContracts(steps: DistilledStep[], today: string): { atoms: ContractAtom[]; edges: ContractEdge[] } {
  const atoms: ContractAtom[] = [];
  const edges: ContractEdge[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s.settle || s.kind === 'raw') continue;
    const id = `v1.procedure.step_${s.catalog.replace(/[^a-z0-9]+/g, '_')}__settle_contract`;
    if (seen.has(id)) continue;
    seen.add(id);
    atoms.push({
      atom: id,
      payload:
        `[REC v1 ${today}] Settle contract for step-catalog capability '${s.catalog}': trigger the action, ` +
        `then settle on a ${s.settle.method} to the ${s.settle.family} URL family (observed burst of ${s.settle.observedCount}; ` +
        `bursts are evidence, never assertion targets). Wait pattern: arm waitForResponse on the family BEFORE the trigger, ` +
        `await it after, then assert app-visible state. networkidle is banned on LEX. ` +
        `Re-verify each seasonal release; on churn mint successor + supersedes + tombstone.`,
    });
    edges.push({ type: 'member_of', source: id, target: 'v1.other.hub_sf_waits' });
    edges.push({ type: 'references', source: id, target: 'v1.procedure.aura_response_wait__surgical_pattern' });
  }
  return { atoms, edges };
}
