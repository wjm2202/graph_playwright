/**
 * `sfpw` — one CLI for this repo (Sprint 4.3, review §3.2 / §4 #5).
 *
 * What it replaces: eight Playwright specs that were really command-line
 * tools, gated on env vars. They inherited `test.skip()`-means-exit-0 (a
 * typo'd `GRILLME=` "passed"), had no `--help`, interleaved their output
 * with a test reporter's, rewrote playwright-report/ on every `npm run
 * doctor`, and made CI run eight no-op tests.
 *
 * What stays a Playwright spec: exactly the four things that need a browser
 * — record, simulate, and the two fixture generators. `sfpw` delegates to
 * them with the env set and forwards their exit code.
 *
 * Contract, everywhere:
 *   exit 0  it worked
 *   exit 1  the honest answer is "no" (not ready, nothing to process, failed)
 *   exit 2  you used it wrong (unknown command, missing argument, bad flag)
 *   errors and progress on stderr; stdout is the answer, and nothing else
 *   when a command is asked for machine output (`grillme --json`).
 */
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { UsageError, type Cli, type CommandRun } from './args';
import * as compose from './compose';
import * as contracts from './contracts';
import * as doctor from './doctor';
import * as fixture from './fixture';
import * as grillme from './grillme';
import * as importCases from './import';
import * as pipeline from './pipeline';
import * as record from './record';
import * as simulate from './simulate';
import * as suite from './suite';
import * as sweep from './sweep';

interface CommandDef {
  /** How the command is typed, as the help lists it. */
  signature: string;
  blurb: string;
  run: CommandRun;
}

const COMMANDS: Record<string, CommandDef> = {
  doctor: { signature: 'doctor [<ref>|all|project:<p>]', blurb: 'the .env lines between you and a runnable graph', run: doctor.run },
  grillme: { signature: 'grillme <ref> [--apply <ops.json>]', blurb: 'every gap as a question (--json for the array alone)', run: grillme.run },
  compose: { signature: 'compose <host> <sub> [--after <s>]', blurb: 'extend one graph with another', run: compose.run },
  import: { signature: 'import <file.xlsx|.csv> [--project <p>]', blurb: 'Azure DevOps test cases → draft graphs', run: importCases.run },
  pipeline: { signature: 'pipeline <journey> [--graph]', blurb: 'recordings/<journey>/ → journey + steps', run: pipeline.run },
  contracts: { signature: 'contracts <journey> [--out <dir>]', blurb: 'harvest MMPM settle contracts (review only)', run: contracts.run },
  sweep: { signature: 'sweep [--delete]', blurb: 'find (and delete) E2E test-data strays', run: sweep.run },
  suite: { signature: 'suite [<spec>]', blurb: 'run the graphs a selection names (Playwright)', run: suite.run },
  record: { signature: 'record <persona> <journey>', blurb: 'capture a flow by driving it once (Playwright)', run: record.run },
  simulate: { signature: 'simulate <ref> [--overwrite]', blurb: 'paint a graph green with no org (Playwright)', run: simulate.run },
  'fixture:trace': { signature: 'fixture:trace', blurb: 'regenerate the committed trace fixture', run: fixture.make('fixture:trace') },
  'fixture:artifacts': { signature: 'fixture:artifacts', blurb: 'regenerate the committed fixture artifacts', run: fixture.make('fixture:artifacts') },
};

const WIDTH = Math.max(...Object.values(COMMANDS).map((c) => c.signature.length));

export const HELP = `sfpw — plan-first, multi-actor Salesforce testing from one command line

usage: sfpw <command> [args] [options]

commands:
${Object.values(COMMANDS).map((c) => `  ${c.signature.padEnd(WIDTH)}  ${c.blurb}`).join('\n')}

options:
  -h, --help    this help, or a command's own: sfpw grillme --help

exit codes: 0 ok · 1 the answer is "no" (not ready / nothing to do / failed) · 2 wrong usage`;

/**
 * Every command reads .env from the directory it acts on, like the suite
 * does. `parse` + populate rather than `config()`: config() logs a banner to
 * STDOUT, and stdout here belongs to the answer (`grillme --json`).
 * A real environment variable always wins over the file.
 */
function loadDotenv(cli: Cli): void {
  const file = path.join(cli.cwd, '.env');
  if (!fs.existsSync(file)) return;
  for (const [key, value] of Object.entries(dotenv.parse(fs.readFileSync(file)))) {
    cli.env[key] ??= value;
  }
}

export async function main(argv: string[], cli: Cli): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === '--help' || name === '-h' || name === 'help') {
    cli.out(HELP);
    return 0;
  }
  const command = COMMANDS[name];
  if (!command) {
    cli.err(`sfpw: unknown command '${name}'`);
    cli.err('');
    cli.err(HELP);
    return 2;
  }

  loadDotenv(cli);
  try {
    return await command.run(rest, cli);
  } catch (e) {
    if (e instanceof UsageError) {
      cli.err(`sfpw ${name}: ${e.message}`);
      if (e.usage !== undefined) {
        cli.err('');
        cli.err(e.usage);
      }
      return 2;
    }
    cli.err(`sfpw ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
