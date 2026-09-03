/**
 * `sfpw fixture:trace` / `sfpw fixture:artifacts` — maintainer commands that
 * regenerate the COMMITTED test fixtures. Both need a browser (the trace is
 * recorded from a real page; the artifact generator runs the full pipeline
 * over it), so both stay Playwright specs and are delegated to.
 *
 * Run them deliberately whenever the Playwright version bumps, then commit
 * the regenerated fixtures.
 */
import { boolFlag, noExtraPositionals, parseArgs, type Cli } from './args';
import { runPlaywright } from './playwright';

const SPECS = {
  'fixture:trace': 'tests/record/make-fixture-trace.spec.ts',
  'fixture:artifacts': 'tests/record/make-fixture-artifacts.spec.ts',
} as const;

export type FixtureCommand = keyof typeof SPECS;

export function usageFor(name: FixtureCommand): string {
  return `usage: sfpw ${name} [--dry-run]

Regenerates the committed fixture from ${SPECS[name]} — a maintainer step
(run it on a Playwright upgrade, then commit the result).`;
}

export function make(name: FixtureCommand): (argv: string[], cli: Cli) => number {
  return (argv, cli) => {
    const args = parseArgs(argv, { booleans: ['dry-run'] });
    if (args.help) {
      cli.out(usageFor(name));
      return 0;
    }
    noExtraPositionals(args, 0, name, usageFor(name));
    return runPlaywright(
      cli,
      ['test', '--project=record', SPECS[name]],
      { GEN_FIXTURE: '1' },
      boolFlag(args, 'dry-run'),
    );
  };
}
