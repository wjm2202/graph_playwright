/**
 * `sfpw doctor [<ref>|all|project:<name>]` — per-graph readiness and the
 * exact .env lines still missing. Diagnosis only: reads env, writes nothing.
 *
 * Exit 1 when anything is not ready, so CI (and a shell `&&`) can gate on it.
 */
import * as path from 'path';
import { envDoctor, formatDoctorReport } from '../personas/doctor';
import { listGraphRefs, resolveGraphRef, type ResolvedGraph } from '../graph/resolve';
import { PersonaRegistry } from '../personas/registry';
import { noExtraPositionals, parseArgs, type Cli } from './args';
import { readGraph } from './graphFile';

export const usage = `usage: sfpw doctor [<ref>|all|project:<name>]

  <ref>              one graph: 'lead_to_customer' or 'salesforce/lead_intake'
  all                every graph in the library (the default)
  project:<name>     every graph in one project

Exit 0 when everything it looked at is READY, 1 when something is missing.`;

export function run(argv: string[], cli: Cli): number {
  const args = parseArgs(argv);
  if (args.help) {
    cli.out(usage);
    return 0;
  }
  noExtraPositionals(args, 1, 'doctor', usage);
  const want = args.positionals[0] ?? 'all';

  let targets: ResolvedGraph[];
  if (want === 'all') {
    targets = listGraphRefs(cli.cwd);
    if (!targets.length) {
      throw new Error(
        'no graphs found — create one in the planner (npm run planner) or scaffold a project (npm run project:new)',
      );
    }
  } else if (want.startsWith('project:')) {
    const project = want.slice('project:'.length);
    targets = listGraphRefs(cli.cwd).filter((r) => r.project === project);
    if (!targets.length) {
      const projects = [...new Set(listGraphRefs(cli.cwd).map((r) => r.project).filter(Boolean))];
      throw new Error(`project '${project}' has no graphs — projects with graphs: ${projects.join(', ') || '(none)'}`);
    }
  } else {
    targets = [resolveGraphRef(want, cli.cwd)];
  }

  const registry = PersonaRegistry.load(path.join(cli.cwd, 'personas.json'));
  let allReady = true;
  for (const target of targets) {
    const report = envDoctor(readGraph(target.file), registry, cli.env);
    allReady = allReady && report.ready;
    cli.out(`\n[${target.ref}]\n${formatDoctorReport(report)}`);
  }

  if (allReady) {
    cli.out('\n✔ everything diagnosed READY — captures and runs will not skip');
    return 0;
  }
  cli.out('\n✗ not runnable yet — fill the .env lines above, then run doctor again');
  return 1;
}
