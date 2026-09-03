#!/usr/bin/env node
/**
 * Project scaffolder — teams create their OWN projects; nothing in the
 * platform hardcodes project names (DESIGN-PROJECTS.md §3).
 *
 *   npm run project:new -- <name> [--team "Team name"]
 *
 * Also imported by serve-planner.mjs (POST /__projects) so the planner's
 * "＋ new project…" runs exactly this code. Zero dependencies, pure node —
 * validation mirrors the repo's id discipline (lower-case, digits, _ or -).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME_RE = /^[a-z][a-z0-9_-]*$/;
const SUBDIRS = ['graphs', 'journeys/baselines', 'steps', 'specs', 'recordings', 'evidence', 'docs'];

/** null when valid, otherwise the human-readable refusal. */
export function badProjectName(name) {
  if (!name) return 'project name required';
  if (!NAME_RE.test(name)) return `'${name}' — lower-case letters, digits, _ or - only (start with a letter)`;
  if (name.length > 40) return 'name too long (max 40)';
  if (name === 'shared' || name === 'projects') return `'${name}' is reserved`;
  return null;
}

/** E2E_<NAME> — threads uniqueName → sweeper → oracle scope per project. */
export function derivedNamePrefix(name) {
  return `E2E_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20)}`;
}

/**
 * Create projects/<name>/ under rootDir. Throws with the reason on refusal.
 * Returns { dir, manifest }.
 */
export function scaffoldProject(rootDir, { project, team = '', description = '' }) {
  const bad = badProjectName(project);
  if (bad) throw new Error(bad);
  const dir = join(rootDir, 'projects', project);
  if (existsSync(dir)) throw new Error(`project '${project}' already exists (${dir})`);

  for (const sub of SUBDIRS) mkdirSync(join(dir, sub), { recursive: true });
  // Keep empty asset dirs in git; scratch dirs (recordings/evidence) are
  // covered by the root .gitignore and stay unkept on purpose.
  for (const keep of ['graphs', 'steps', 'specs', 'journeys/baselines']) {
    writeFileSync(join(dir, keep, '.gitkeep'), '');
  }

  const manifest = {
    project,
    team,
    description,
    systems: [],
    uses: [],
    namePrefix: derivedNamePrefix(project),
  };
  writeFileSync(join(dir, 'project.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(dir, 'docs', 'README.md'),
    `# ${project}\n\n${description || `Testing project for ${team || project}.`}\n\n` +
      `- Graphs: \`graphs/*.graph.json\` — open them in the planner (\`npm run planner\`).\n` +
      `- Gaps: \`GRILLME=${project}/<graph_id> npm run grillme\`\n` +
      `- Readiness: \`GRAPH_DOCTOR=project:${project} npm run doctor\`\n` +
      `- Run: \`SUITE=graph:${project}/<graph_id> npm run suite\` (whole project: \`SUITE=project:${project}\`)\n`,
  );
  return { dir, manifest };
}

/** Every project manifest under rootDir/projects (filesystem = the registry). */
export function listProjects(rootDir) {
  const base = join(rootDir, 'projects');
  if (!existsSync(base)) return [];
  const out = [];
  for (const name of readdirSync(base, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const manifestFile = join(base, name.name, 'project.json');
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      const graphsDir = join(base, name.name, 'graphs');
      const graphs = existsSync(graphsDir)
        ? readdirSync(graphsDir).filter((f) => f.endsWith('.graph.json')).length
        : 0;
      out.push({ ...manifest, project: manifest.project ?? name.name, graphs });
    } catch {
      out.push({ project: name.name, team: '', invalid: true, graphs: 0 });
    }
  }
  return out.sort((a, b) => a.project.localeCompare(b.project));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const teamIx = args.indexOf('--team');
  const team = teamIx >= 0 ? (args[teamIx + 1] ?? '') : '';
  const name = args.filter((_, i) => teamIx < 0 || (i !== teamIx && i !== teamIx + 1))[0];
  try {
    const { dir, manifest } = scaffoldProject(resolve('.'), { project: name, team });
    console.log(`✔ project '${manifest.project}' created at ${dir}`);
    console.log(`  namePrefix: ${manifest.namePrefix} · team: ${manifest.team || '(unset — edit project.json)'}`);
    console.log(`  next: open the planner (npm run planner) and pick it in the project ▾ selector,`);
    console.log(`        or drop a graph at projects/${manifest.project}/graphs/<id>.graph.json`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    process.exit(1);
  }
}
