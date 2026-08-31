/**
 * R4 — generator: Distillation → four reviewable artifacts.
 *   1. journeys/<id>.generated.json      — schema-valid journey (single actor v1)
 *   2. src/journeys/generated/<id>.steps.ts — WORKING implementations for the
 *      starter vocabulary (component objects already exist); raw steps get
 *      loud throw-stubs so nothing passes vacuously
 *   3. journeys/baselines/<id>.baselines.json — initial timing (n=1 windows)
 *      via the R0 lifecycle (same code path as live updates)
 *   4. L2/encoding/batch-rec-<id>.json   — settle-contract atoms, validator-clean,
 *      NEVER auto-published (orchestrator reviews, then checkpoints)
 *
 * Hard rule (test-enforced): no emitted artifact ever contains 'networkidle' —
 * settle waits are URL-family waitForResponse + app-visible assertions
 * (substrate: networkidle__valid_on_lex__false, step_settle_contract__atom_pattern).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { Distillation, DistilledStep } from './distill';
import { summarizeEvidence, type DenialEvidence } from './denial';
import { validateJourney, type ActorStep, type Journey, type JourneyStep } from '../journeys/schema';
import { updateBaselines, emptyBaselines, saveBaselinesFile, type StoredBaselines } from '../journeys/baselines';
import type { JourneyReport } from '../journeys/runner';
import { compact } from '../utils/compact';

export interface GenerateOptions {
  journeyId: string;
  /** Single-recording persona (manifest) — becomes actors.main. */
  persona?: string;
  /** Multi-actor journeys (R6 stitch): alias → personaId. Overrides persona. */
  actors?: Record<string, string>;
  /** Known persona ids (personas.json) for journey validation. */
  personaIds: string[];
  /**
   * Deny mode (R5): the recording was made AS THE WRONG PERSONA with
   * --expect-denial. Evidence MUST be non-empty — a captured success is
   * refused, never encoded as an expectation.
   */
  deny?: { capability: string; target?: unknown; evidence: DenialEvidence[] };
  outDirs?: { journeys?: string; stubs?: string; baselines?: string; encoding?: string };
  today?: string;
}

export interface GenerateResult {
  journey: Journey;
  journeyFile: string;
  stubsFile: string;
  /** Absent in deny mode (no performance surface to baseline). */
  baselinesFile?: string;
  /** Present only when settle signals were captured. */
  batchFile?: string;
  flags: string[];
}

export function generateArtifacts(d: Distillation, opts: GenerateOptions): GenerateResult {
  const dirs = {
    journeys: opts.outDirs?.journeys ?? 'journeys',
    stubs: opts.outDirs?.stubs ?? path.join('src', 'journeys', 'generated'),
    baselines: opts.outDirs?.baselines ?? path.join('journeys', 'baselines'),
    encoding: opts.outDirs?.encoding ?? path.join('L2', 'encoding'),
  };
  const flags = [...d.flags];
  const actors = opts.actors ?? (opts.persona ? { main: opts.persona } : undefined);
  if (!actors) throw new Error('generateArtifacts: provide persona (single recording) or actors (stitched)');
  const soleAlias = Object.keys(actors)[0] ?? 'main';

  // ---- 1. journey JSON -----------------------------------------------------
  let steps: JourneyStep[];
  if (opts.deny) {
    if (opts.deny.evidence.length === 0) {
      throw new Error(
        `expected a denial, captured success — the '${opts.journeyId}' recording as '${actors[soleAlias] ?? soleAlias}' completed ` +
          `'${opts.deny.capability}' without refusal. Refusing to encode a security hole as an expectation; ` +
          'fix the org permissions (or the capability name) and re-record.',
      );
    }
    steps = [
      {
        deny: {
          actor: soleAlias,
          capability: opts.deny.capability,
          ...(opts.deny.target !== undefined ? { target: opts.deny.target } : {}),
        },
      },
    ];
    flags.push(`deny '${opts.deny.capability}' evidenced by: ${summarizeEvidence(opts.deny.evidence)}`);
  } else {
    steps = d.steps.map((s, i): ActorStep => {
      const doName = s.kind === 'raw' ? `raw.name_me_${i}` : s.catalog;
      const withArgs: Record<string, unknown> = { ...s.args };
      if (s.settle) withArgs.settle = s.settle.family; // settle hint rides the args
      return { actor: s.actorAlias ?? soleAlias, do: doName, ...(Object.keys(withArgs).length ? { with: withArgs } : {}) };
    });
  }

  const journey: Journey = {
    journey: opts.journeyId,
    description: `Generated from a recording (pipeline v1, ${opts.today ?? new Date().toISOString().slice(0, 10)}). Review before trusting; raw steps must be named.`,
    actors,
    steps,
  };
  const validation = validateJourney(journey, { personaIds: opts.personaIds });
  if (!validation.ok) {
    throw new Error(`generator produced an invalid journey (bug):\n - ${validation.errors.join('\n - ')}`);
  }

  fs.mkdirSync(dirs.journeys, { recursive: true });
  const journeyFile = path.join(dirs.journeys, `${opts.journeyId}.generated.json`);
  fs.writeFileSync(journeyFile, JSON.stringify(journey, null, 2) + '\n');

  // ---- 2. step implementations --------------------------------------------
  fs.mkdirSync(dirs.stubs, { recursive: true });
  const stubsFile = path.join(dirs.stubs, `${opts.journeyId}.steps.ts`);
  fs.writeFileSync(
    stubsFile,
    opts.deny
      ? renderDeny(opts.journeyId, opts.deny.capability, opts.deny.evidence)
      : renderSteps(opts.journeyId, d.steps),
  );

  // ---- 3. baselines via the R0 lifecycle (skipped in deny mode) ------------
  let baselinesFile: string | undefined;
  if (!opts.deny) {
    const actorSteps = steps as ActorStep[];
    const report: JourneyReport = {
      journey: opts.journeyId,
      flags: [],
      steps: d.steps.map((s, i) => {
        const a = actorSteps[i]!; // actorSteps is mapped 1:1 from d.steps above
        return {
        index: i,
        kind: 'do' as const,
        actorAlias: a.actor,
        personaId: actors[a.actor] ?? a.actor,
        name: a.do,
        ms: Math.max(0, Math.round(s.durationMs)),
        status: 'ok' as const,
      };
      }),
    };
    const baselines: StoredBaselines = updateBaselines(emptyBaselines(opts.journeyId), report, compact({
      today: opts.today,
    }));
    baselinesFile = path.join(dirs.baselines, `${opts.journeyId}.baselines.json`);
    saveBaselinesFile(baselinesFile, baselines);
  }

  // ---- 4. settle-contract batch (review-then-publish) ----------------------
  let batchFile: string | undefined;
  const contracts = opts.deny
    ? { atoms: [], edges: [] }
    : settleContracts(d.steps, opts.today ?? new Date().toISOString().slice(0, 10));
  if (contracts.atoms.length) {
    fs.mkdirSync(dirs.encoding, { recursive: true });
    batchFile = path.join(dirs.encoding, `batch-rec-${opts.journeyId.replace(/_/g, '-')}.json`);
    fs.writeFileSync(
      batchFile,
      JSON.stringify(
        {
          batch: `rec-${opts.journeyId}`,
          description:
            `Settle contracts harvested from the '${opts.journeyId}' recording (pipeline v1). ` +
            'REVIEW BEFORE PUBLISHING — the pipeline never checkpoints directly.',
          atoms: contracts.atoms,
          edges: contracts.edges,
        },
        null,
        2,
      ) + '\n',
    );
  }

  for (const s of d.steps.filter((x) => x.kind === 'raw')) {
    flags.push(`journey '${opts.journeyId}' carries an unnamed raw step (${JSON.stringify(s.args)}) — name it before relying on this journey`);
  }

  return compact({ journey, journeyFile, stubsFile, baselinesFile, batchFile, flags });
}

/** One contract atom per capability that showed a settle signal (deduped). */
function settleContracts(steps: DistilledStep[], today: string) {
  const atoms: { atom: string; payload: string }[] = [];
  const edges: { type: string; source: string; target: string }[] = [];
  const seen = new Set<string>();
  for (const s of steps) {
    if (!s.settle || s.kind === 'raw') continue;
    const id = `v1.procedure.step_${s.catalog.replace(/[^a-z0-9]+/g, '_')}__settle_contract`;
    if (seen.has(id)) continue;
    seen.add(id);
    atoms.push({
      atom: id,
      payload:
        `[REC v1 ${today}] Settle contract for step-catalog capability '${s.catalog}': trigger the action, ` +
        `then settle on a ${s.settle.method} to the ${s.settle.family} URL family (observed burst of ${s.settle.observedCount}; ` +
        `bursts are evidence, never assertion targets). Wait pattern: arm waitForResponse on the family BEFORE the trigger, ` +
        `await it after, then assert app-visible state. networkidle is banned on LEX. ` +
        `Re-verify each seasonal release; on churn mint successor + supersedes + tombstone.`,
    });
    edges.push({ type: 'member_of', source: id, target: 'v1.other.hub_sf_waits' });
    edges.push({ type: 'references', source: id, target: 'v1.procedure.aura_response_wait__surgical_pattern' });
  }
  return { atoms, edges };
}

/** Emit compilable TypeScript: real impls for the vocabulary, loud raw stubs. */
function renderSteps(journeyId: string, steps: DistilledStep[]): string {
  const used = new Set(steps.filter((s) => s.kind === 'step').map((s) => s.catalog));
  const lines: string[] = [];
  lines.push('/**');
  lines.push(` * GENERATED by the recording pipeline for journey '${journeyId}'.`);
  lines.push(' * Starter-vocabulary steps are real implementations over the component');
  lines.push(' * objects; raw steps throw until a human names them (grammar growth).');
  lines.push(' * Regenerate rather than hand-editing recognized steps.');
  lines.push(' */');
  lines.push("import type { StepCatalog } from '../catalog';");
  lines.push('');
  lines.push(`export function registerSteps_${journeyId}(catalog: StepCatalog): StepCatalog {`);
  lines.push('  return catalog');

  if (used.has('nav.goto')) {
    lines.push("    .register('nav.goto', async ({ page, args }) => {");
    lines.push('      await page.goto(String(args.url));');
    lines.push('    })');
  }
  if (used.has('recordPage.open')) {
    lines.push("    .register('recordPage.open', async ({ page, args }) => {");
    lines.push("      await page.goto('/lightning/r/' + String(args.sobject) + '/' + String(args.id) + '/view');");
    lines.push('    })');
  }
  if (used.has('form.fill')) {
    lines.push("    .register('form.fill', async ({ page, args }) => {");
    lines.push('      await page.getByLabel(String(args.label)).fill(String(args.value));');
    lines.push('    })');
  }
  if (used.has('combobox.select')) {
    lines.push("    .register('combobox.select', async ({ lightning, args }) => {");
    lines.push('      await lightning.combobox(String(args.label)).select(String(args.option));');
    lines.push('    })');
  }
  if (used.has('ui.click')) {
    lines.push("    .register('ui.click', async ({ page, args }) => {");
    lines.push('      if (args.role !== undefined) {');
    lines.push("        await page.getByRole(args.role as Parameters<typeof page.getByRole>[0], args.name !== undefined ? { name: String(args.name) } : undefined).click();");
    lines.push('      } else if (args.label !== undefined) await page.getByLabel(String(args.label)).click();');
    lines.push('      else if (args.text !== undefined) await page.getByText(String(args.text)).click();');
    lines.push('      else await page.getByTestId(String(args.testId)).click();');
    lines.push('    })');
  }
  if (used.has('modal.save')) {
    lines.push("    .register('modal.save', async ({ page, lightning, args }) => {");
    lines.push("      const settled = args.settle === 'aura' ? lightning.auraResponse() : undefined;");
    lines.push("      await page.getByRole('button', { name: String(args.button) }).click();");
    lines.push('      if (settled) await settled;');
    lines.push('    })');
  }
  steps.forEach((s, i) => {
    if (s.kind !== 'raw') return;
    lines.push(`    .register('raw.name_me_${i}', async () => {`);
    lines.push(
      `      throw new Error(${JSON.stringify(
        `unnamed raw step from the '${journeyId}' recording: ${JSON.stringify(s.args)} — name it in the grammar, then regenerate`,
      )});`,
    );
    lines.push('    })');
  });
  lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''};`; // array non-empty: pushes above
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

/** Deny recordings emit a probe REGISTRATION stub that fails loudly until a
 *  human implements both halves — an unimplemented probe can never pass. */
function renderDeny(journeyId: string, capability: string, evidence: DenialEvidence[]): string {
  const summary = summarizeEvidence(evidence);
  const msg =
    `implement the deny probe for '${capability}' (journey '${journeyId}'): ` +
    `UI half = assert the control is absent or the refusal surfaces for that persona; ` +
    `API half = attempt the operation as that persona and report {denied:true} on refusal. ` +
    `Recorded evidence: ${summary}`;
  return [
    '/**',
    ` * GENERATED deny-probe stub for journey '${journeyId}' (--expect-denial recording).`,
    ` * Evidence captured: ${summary}`,
    ' * The factory throws until implemented — an unimplemented probe never passes.',
    ' */',
    "import type { StepCatalog } from '../catalog';",
    '',
    `export function registerDeny_${journeyId}(catalog: StepCatalog): StepCatalog {`,
    `  return catalog.registerDeny(${JSON.stringify(capability)}, () => {`,
    `    throw new Error(${JSON.stringify(msg)});`,
    '  });',
    '}',
    '',
  ].join('\n');
}
