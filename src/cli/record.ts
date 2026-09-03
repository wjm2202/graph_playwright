/**
 * `sfpw record <persona> <journey> [--expect-denial]` — a headed capture
 * session. Delegates to tests/record/record.spec.ts: driving a real browser
 * is exactly the thing Playwright is for.
 *
 * Drive the flow naturally; CLOSE THE BROWSER PAGE to finish. Artifacts land
 * in recordings/<journey>/<persona>-<ts>/.
 */
import { noExtraPositionals, parseArgs, boolFlag, UsageError, type Cli } from './args';
import { runPlaywright } from './playwright';

export const usage = `usage: sfpw record <persona> <journey> [--expect-denial] [--dry-run]

  <persona>          a persona id from personas.json
  <journey>          the journey id the capture belongs to
  --expect-denial    drive AS THE WRONG persona into the refusal (a deny step)
  --dry-run          print the Playwright command instead of running it`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { booleans: ['expect-denial', 'dry-run'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const [persona, journey] = args.positionals;
  if (persona === undefined || journey === undefined) {
    throw new UsageError('record needs a persona and a journey', usage);
  }
  noExtraPositionals(args, 2, 'record', usage);

  return runPlaywright(
    cli,
    ['test', '--project=record', 'tests/record/record.spec.ts', '--headed'],
    {
      RECORD_PERSONA: persona,
      RECORD_JOURNEY: journey,
      ...(boolFlag(args, 'expect-denial') ? { RECORD_EXPECT_DENIAL: '1' } : {}),
    },
    boolFlag(args, 'dry-run'),
  );
}
