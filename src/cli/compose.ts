/**
 * `sfpw compose <host> <sub> [--after <session>] [--island]` — extend one
 * graph with another (DESIGN-PROJECTS.md reuse).
 *
 * Default is ISLAND: the sub arrives intact but unwired — connect it in the
 * planner (chain health lists the stranded sessions). `--after <session>`
 * opts into the auto-splice. Copy-merge with provenance: the HOST file is
 * rewritten (git is the undo); the sub is never touched.
 */
import { composeGraphs } from '../graph/compose';
import { resolveGraphRef } from '../graph/resolve';
import { boolFlag, noExtraPositionals, parseArgs, stringFlag, UsageError, type Cli } from './args';
import { readGraph, writeGraph } from './graphFile';

export const usage = `usage: sfpw compose <host_ref> <sub_ref> [--after <session_id>] [--island]

  <host_ref>          the graph that is rewritten (the sub is never touched)
  <sub_ref>           the graph copied into it
  --after <session>   splice the sub's chain after this host session
  --island            the default: arrive unwired, connect it in the planner`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { booleans: ['island'], strings: ['after'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const [host, sub] = args.positionals;
  if (host === undefined || sub === undefined) {
    throw new UsageError('compose needs a host ref and a sub ref', usage);
  }
  noExtraPositionals(args, 2, 'compose', usage);

  const after = stringFlag(args, 'after');
  if (after !== undefined && boolFlag(args, 'island')) {
    throw new UsageError('--island and --after are opposites — pick one', usage);
  }

  const hostRef = resolveGraphRef(host, cli.cwd);
  const subRef = resolveGraphRef(sub, cli.cwd);
  const result = composeGraphs(readGraph(hostRef.file), readGraph(subRef.file), {
    ref: subRef.ref,
    ...(after !== undefined ? { after } : { mode: 'island' as const }),
  });
  writeGraph(hostRef.file, result.graph);

  cli.out(`✔ '${subRef.ref}' composed into '${hostRef.ref}' (${hostRef.file}):`);
  for (const line of result.summary) cli.out(`  · ${line}`);
  cli.out(`next:  sfpw grillme ${hostRef.ref}   ·   open it in the planner (check panel shows any new gaps)`);
  return 0;
}
