/**
 * `sfpw grillme <ref> [--apply <ops.json>] [--json]` — the gap engine's
 * hands: every unanswerable thing in a graph as a multiple-choice question,
 * and the write-back that applies the answers.
 *
 * `--json` prints ONE thing on stdout: the `Gap[]` array. That is the
 * contract the /grillme skill parses (it replaces the old `GAPS_JSON <…>`
 * line scraped out of a Playwright reporter's stdout). Everything else —
 * applied changes, chain warnings — goes to stderr in that mode.
 */
import * as fs from 'fs';
import * as path from 'path';
import { chainHealth } from '../graph/compose';
import { applyAnswers, computeGaps, type AnswerOp } from '../graph/gaps';
import { listGraphRefs, resolveGraphRef } from '../graph/resolve';
import { PersonaRegistry } from '../personas/registry';
import { boolFlag, noExtraPositionals, parseArgs, stringFlag, UsageError, type Cli } from './args';
import { readGraph, writeGraph } from './graphFile';

export const usage = `usage: sfpw grillme <ref> [--apply <ops.json>] [--json]

  <ref>              'lead_to_customer' or 'salesforce/lead_intake'
  --apply <file>     an AnswerOp[] JSON file (see src/graph/gaps.ts) — applied
                     to the graph, in place, before the gaps are listed again
  --json             print ONLY the Gap[] array on stdout (for tools/skills)`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { booleans: ['json'], strings: ['apply'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  const ref = args.positionals[0];
  if (ref === undefined) throw new UsageError('grillme needs a graph ref', usage);
  noExtraPositionals(args, 1, 'grillme', usage);

  const json = boolFlag(args, 'json');
  // In --json mode stdout carries the array and nothing else.
  const say = json ? cli.err : cli.out;
  const target = resolveGraphRef(ref, cli.cwd);
  const registry = PersonaRegistry.load(path.join(cli.cwd, 'personas.json'));

  const applyFile = stringFlag(args, 'apply');
  if (applyFile !== undefined) {
    const ops = JSON.parse(fs.readFileSync(path.resolve(cli.cwd, applyFile), 'utf8')) as AnswerOp[];
    const result = applyAnswers(readGraph(target.file), ops);
    writeGraph(target.file, result.graph);
    say(`✔ ${result.changes.length} answers applied to ${target.file}:`);
    for (const change of result.changes) say(`  · ${change}`);
  }

  const graph = readGraph(target.file);
  const { gaps, hints } = computeGaps(graph, {
    knownPersonas: registry.ids(),
    settledSystems: settledSystemsIn(target.project, target.file, cli.cwd),
  });
  if (json) {
    cli.out(JSON.stringify(gaps));
    return 0;
  }

  const chain = chainHealth(graph);
  for (const err of chain.errors) cli.out(`  [chain] MUST FIX: ${err}`);
  for (const sess of chain.stranded) {
    cli.out(`  [chain] session '${sess}' is not on the login chain — a run will never reach it`);
  }
  cli.out(`\ngaps for '${target.ref}': ${gaps.length}`);
  for (const gap of gaps) {
    cli.out(`  [${gap.kind}] ${gap.at}: ${gap.question}${gap.options ? `  (${gap.options.join(' / ')})` : ''}`);
  }
  if (!gaps.length) {
    cli.out('✔ nothing left to ask — remaining work is captures (see not_captured above if any) and running it');
  }
  if (hints.length) {
    cli.out(`\nhints (advice, never blocking): ${hints.length}`);
    for (const hint of hints) cli.out(`  [${hint.kind}] ${hint.at}: ${hint.short}`);
  }
  return 0;
}

/**
 * A session policy is a property of the SYSTEM, not of one graph (review
 * §3.1), so it is asked once per project: any sibling graph in the same
 * project that already declares a policy for a system settles it here too.
 * A graph with no project (journeys/graphs/) has no siblings — the question
 * stays per graph, exactly as before.
 */
function settledSystemsIn(project: string | undefined, self: string, cwd: string): string[] {
  if (project === undefined) return [];
  const out = new Set<string>();
  for (const row of listGraphRefs(cwd)) {
    if (row.project !== project || row.file === self) continue;
    let sibling;
    try { sibling = readGraph(row.file); } catch { continue; }
    for (const [key, sys] of Object.entries(sibling.systems)) {
      if (sys.sessionPolicy) out.add(key);
    }
  }
  return [...out];
}
