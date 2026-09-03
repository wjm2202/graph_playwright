/**
 * `sfpw suite [<spec>] [playwright args…]` — run every graph a selection
 * names, through the one generic runner (tests/e2e/graphs.spec.ts).
 *
 * `<spec>` is a suite name from suites.json, or a direct selector
 * (`graph:<ref>`, `tag:<t>`, `project:<p>`, or a comma list). It defaults to
 * `smoke`, the same default the runner has always had. Unrecognised options
 * are forwarded to Playwright, so `sfpw suite smoke --list` and
 * `sfpw suite smoke --repeat-each=2` work.
 */
import { boolFlag, noExtraPositionals, parseArgs, type Cli } from './args';
import { runPlaywright } from './playwright';

export const usage = `usage: sfpw suite [<spec>] [playwright args…]

  <spec>       a suite from suites.json, or graph:<ref> | tag:<t> | project:<p>
               (comma-separated; default 'smoke')
  --dry-run    print the Playwright command instead of running it

Anything sfpw does not recognise is passed through to Playwright:
  sfpw suite smoke --list        sfpw suite tag:sod -- --repeat-each=2`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { booleans: ['dry-run'], passthrough: true });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  noExtraPositionals(args, 1, 'suite', usage);
  const spec = args.positionals[0] ?? 'smoke';

  return runPlaywright(
    cli,
    ['test', '--project=e2e', ...args.passthrough],
    { SUITE: spec },
    boolFlag(args, 'dry-run'),
  );
}
