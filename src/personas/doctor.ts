/**
 * S3 — the env doctor: walk a graph → its actors → their personas → the
 * exact .env lines standing between you and a runnable graph. The tool holds
 * the checklist; the human only ever sees the one next thing to do.
 */
import type { PersonaRegistry } from './registry';
import type { ProcessGraph } from '../graph/schema';

export interface PersonaReadiness {
  alias: string;
  personaId: string;
  known: boolean;
  ready: boolean;
  /** env names to set (token OR user+pass — any full set clears it). */
  missing: string[];
  /** Informational: TOTP secret env declared but unset (matters only under MFA). */
  totpNote?: string;
}

export interface DoctorReport {
  graphId: string;
  ready: boolean;
  org: { env: string; set: boolean };
  sites: { site: string; env: string; set: boolean }[];
  personas: PersonaReadiness[];
  /** Copy-paste .env skeleton for everything missing. */
  envLines: string[];
}

export function envDoctor(
  graph: ProcessGraph,
  registry: PersonaRegistry,
  env: NodeJS.ProcessEnv = process.env,
): DoctorReport {
  const orgEnv = registry.orgUrlEnvName();
  const report: DoctorReport = {
    graphId: graph.id,
    ready: true,
    org: { env: orgEnv, set: isSet(env[orgEnv]) },
    sites: [],
    personas: [],
    envLines: [],
  };
  if (!report.org.set) report.envLines.push(`${orgEnv}=`);

  const seenSites = new Set<string>();
  for (const [alias, personaId] of actorBindings(graph)) {
    const known = registry.ids().includes(personaId);
    if (!known) {
      report.personas.push({ alias, personaId, known: false, ready: false, missing: [] });
      continue;
    }
    const ready = registry.hasCreds(personaId, env);
    const missing = ready ? [] : registry.missingEnvNames(personaId, env);
    const totpName = registry.envNamesFor(personaId).totp;
    const totpNote = totpName && !isSet(env[totpName])
      ? `totp ${totpName} unset — needed only if MFA is enforced`
      : undefined;
    report.personas.push({ alias, personaId, known: true, ready, missing, ...(totpNote ? { totpNote } : {}) });
    for (const name of missing) if (!report.envLines.includes(`${name}=`)) report.envLines.push(`${name}=`);

    const site = registry.siteUrlEnvName(personaId);
    if (site && !seenSites.has(site.site)) {
      seenSites.add(site.site);
      const set = isSet(env[site.env]);
      report.sites.push({ site: site.site, env: site.env, set });
      if (!set) report.envLines.push(`${site.env}=`);
    }
  }

  report.ready =
    report.org.set &&
    report.sites.every((s) => s.set) &&
    report.personas.every((p) => p.known && p.ready);
  return report;
}

/** Human-readable diagnosis, one line per fact, ending in the next action. */
export function formatDoctorReport(r: DoctorReport): string {
  const lines: string[] = [`graph '${r.graphId}' — ${r.ready ? 'READY to run' : 'not runnable yet'}`];
  lines.push(`  org url  ${mark(r.org.set)} ${r.org.env}`);
  for (const s of r.sites) lines.push(`  site     ${mark(s.set)} ${s.site} (${s.env})`);
  for (const p of r.personas) {
    if (!p.known) lines.push(`  persona  ✗ ${p.alias} → '${p.personaId}' NOT in personas.json`);
    else if (p.ready) lines.push(`  persona  ✓ ${p.alias} → ${p.personaId}${p.totpNote ? ` (${p.totpNote})` : ''}`);
    else lines.push(`  persona  ✗ ${p.alias} → ${p.personaId} — set ${p.missing.join(' or ') || 'credentials'}`);
  }
  if (r.envLines.length) {
    lines.push('  add to .env (see SETUP-REAL-ORG.md for the org-side users):');
    for (const l of r.envLines) lines.push(`    ${l}`);
  }
  return lines.join('\n');
}

function actorBindings(graph: ProcessGraph): [string, string][] {
  const used = new Set<string>();
  for (const n of graph.nodes) if (n.type === 'session' && n.actor) used.add(n.actor);
  const aliases = used.size ? [...used] : Object.keys(graph.actors);
  return aliases.map((a) => [a, graph.actors[a] ?? a]);
}

function isSet(v: string | undefined): boolean {
  return !!v?.trim();
}

function mark(ok: boolean): string {
  return ok ? '✓' : '✗';
}
