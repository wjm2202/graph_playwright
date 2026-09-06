/**
 * `sfpw import <file.xlsx|.csv> [--project <p>]` / `sfpw import --paste <file.txt>`
 *
 * Azure DevOps test cases → DRAFT process graphs. Never overwrites an
 * existing graph (suffixes `_ado`), and prints every confidence flag so
 * grillme — or a human — can correct the guesses.
 *
 * With `--project`, the export itself is kept as a project asset
 * (projects/<p>/imports/) beside a manifest that remembers which cases
 * became which graphs; without it, drafts land in the legacy flat
 * journeys/graphs/ folder, exactly as `npm run ado:import` always did.
 */
import * as fs from 'fs';
import * as path from 'path';
import { applyImport, storeImport } from '../graph/adoImports';
import { describeChains, linkCases, type LinkageResult } from '../graph/adoLinkage';
import { adoCaseToGraph, parseAdoPaste, writeAdoGraph, type AdoCase } from '../graph/fromAdo';
import { parseAdoFile } from '../graph/fromAdoXlsx';
import { PersonaRegistry } from '../personas/registry';
import { noExtraPositionals, parseArgs, stringFlag, UsageError, type Cli } from './args';

export const usage = `usage: sfpw import <file.xlsx|.csv> [--project <name>]
       sfpw import --paste <file.txt> [--project <name>]

  <file>             an Azure DevOps test-case export (.xlsx or .csv)
  --paste <file>     a text file of pasted steps ("Title: …", "1. as a …| …")
  --project <name>   import into projects/<name>/ and keep the export there;
                     without it, drafts go to journeys/graphs/`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv, { strings: ['paste', 'project'] });
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  noExtraPositionals(args, 1, 'import', usage);
  const file = args.positionals[0];
  const paste = stringFlag(args, 'paste');
  const project = stringFlag(args, 'project');
  if (file === undefined && paste === undefined) {
    throw new UsageError('import needs an export file, or --paste <file.txt>', usage);
  }
  if (file !== undefined && paste !== undefined) {
    throw new UsageError('import takes a file OR --paste, not both', usage);
  }

  const knownPersonas = PersonaRegistry.load(path.join(cli.cwd, 'personas.json')).ids();

  // A stored, re-importable project asset — only a real export file can be one.
  if (file !== undefined && project !== undefined) {
    const abs = path.resolve(cli.cwd, file);
    const stored = storeImport(cli.cwd, project, path.basename(abs), fs.readFileSync(abs));
    for (const sheet of stored.skippedSheets) cli.err(`  ⚑ sheet '${sheet}' held no test cases — skipped`);
    const applied = applyImport(
      cli.cwd,
      project,
      stored.manifest.id,
      stored.cases.map((_, index) => index),
      { knownPersonas },
    );
    cli.out(`✔ kept the export as projects/${project}/imports/${stored.manifest.file}`);
    for (const item of applied.results) {
      cli.out(`\n✔ draft graph: ${item.graphFile}  (${item.nodes} nodes, ${item.edges} edges)`);
      for (const flag of item.flags) cli.out(`  ⚑ ${flag}`);
    }
    printChains(cli, linkCases(stored.cases));
    cli.out(`  next: open them in the planner (npm run planner) — confirm the draft? checks, bind roles, then capture`);
    return 0;
  }

  const cases: AdoCase[] =
    file !== undefined
      ? parseAdoFile(path.resolve(cli.cwd, file), fs.readFileSync(path.resolve(cli.cwd, file))).cases
      : [parseAdoPaste(fs.readFileSync(path.resolve(cli.cwd, paste ?? ''), 'utf8'))];
  if (!cases.length) throw new Error('no test cases found in the input');

  const dir =
    project === undefined
      ? path.resolve(cli.cwd, 'journeys', 'graphs')
      : projectGraphsDir(cli.cwd, project);

  const linkage = linkCases(cases);
  cases.forEach((tc, index) => {
    const written = writeAdoGraph(adoCaseToGraph(tc, { knownPersonas }), dir);
    cli.out(`\n✔ draft graph: ${written.graphFile}  (${written.graph.nodes.length} nodes, ${written.graph.edges.length} edges)`);
    for (const flag of written.flags) cli.out(`  ⚑ ${flag}`);
    for (const flag of linkage.flags[index] ?? []) cli.out(`  ⚑ sequence: ${flag}`);
  });
  printChains(cli, linkage);
  cli.out(`  next: open it in the planner (npm run planner) — confirm the draft? checks, bind roles, then capture`);
  return 0;
}

/** The journeys the cases form, read from their language — one graph per
 *  case is still written; this tells the human which ones belong together. */
function printChains(cli: Cli, linkage: LinkageResult): void {
  const lines = describeChains(linkage);
  if (!lines.length) return;
  cli.out(`\n⛓ sequences read from the steps (case #index → continues in):`);
  for (const line of lines) cli.out(`  ${line}`);
  cli.out(`  join them with: sfpw compose <host_ref> <sub_ref> (splice) once the drafts are confirmed`);
}

function projectGraphsDir(root: string, project: string): string {
  const dir = path.join(root, 'projects', project);
  if (!fs.existsSync(path.join(dir, 'project.json'))) {
    throw new Error(`project '${project}' does not exist — create it first (npm run project:new -- ${project})`);
  }
  return path.join(dir, 'graphs');
}
