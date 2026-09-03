/**
 * `sfpw simulate <ref> [--overwrite]` — paint a graph green WITHOUT an org.
 *
 * Delegates to tests/record/simulate.spec.ts: the "SIMULATED" evidence cards
 * are rendered by a real page, so this one keeps its browser.
 */
import { boolFlag, noExtraPositionals, parseArgs, UsageError, type Cli } from './args';
import { runPlaywright } from './playwright';

export const usage = `usage: sfpw simulate <ref> [--overwrite] [--dry-run]

  <ref>          'lead_to_customer' or 'salesforce/lead_intake'
  --overwrite    let the simulated steps module replace real pipeline output
  --dry-run      print the Playwright command instead of running it`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { booleans: ['overwrite', 'dry-run'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError('simulate needs a graph ref', usage);
  noExtraPositionals(args, 1, 'simulate', usage);

  return runPlaywright(
    cli,
    ['test', '--project=record', 'tests/record/simulate.spec.ts'],
    {
      SIMULATE: ref,
      ...(boolFlag(args, 'overwrite') ? { SIMULATE_OVERWRITE: '1' } : {}),
    },
    boolFlag(args, 'dry-run'),
  );
}
