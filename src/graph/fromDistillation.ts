/**
 * PG-1 — capture → graph (the process-mining half, design doc §3.3).
 *
 * Per-step mode: one action node per distilled step in actor lanes, `next`
 * edges carrying the gap timing the human actually experienced, `navigates`
 * edges into navigation steps, and `handoff` edges where a harvested record id
 * crosses actors (the journey's shared record).
 *
 * Aggregate mode: a classic (object-centric-flavored) directly-follows graph —
 * activities keyed by (actor, catalog) with frequency + mean/p95 durations,
 * DF edges with frequency + mean gap. Same numbers the baselines use.
 */

import type { Distillation, DistilledStep } from '../pipeline/distill';
import { p95, mean } from '../journeys/baselines';
import type { PNode, ProcessGraph, SystemDef } from './schema';
import { asText } from '../utils/text';

export interface FromDistillationOptions {
  graphId: string;
  /** alias → personas.json id (single recordings: { main: persona }). */
  actors: Record<string, string>;
  systems?: Record<string, SystemDef>;
  /** URL origin → system key, e.g. { 'https://uat.my.salesforce.com': 'sf' }. */
  systemByOrigin?: Record<string, string>;
  /** Back-reference stamped onto captured steps placeholders. */
  journeyId?: string;
  aggregate?: boolean;
  title?: string;
}

const NAV_CATALOGS = new Set(['nav.goto', 'recordPage.open']);

export function fromDistillation(d: Distillation, opts: FromDistillationOptions): ProcessGraph {
  const systems = opts.systems ?? { app: { label: 'Application', kind: 'web' } };
  const defaultSystem = Object.keys(systems)[0] ?? 'app'; // systems defaults above — never empty
  const soleAlias = Object.keys(opts.actors)[0] ?? 'main';

  const graph: ProcessGraph = {
    schema: 'process-graph/1',
    id: opts.graphId,
    ...(opts.title ? { title: opts.title } : {}),
    systems,
    actors: opts.actors,
    nodes: [],
    edges: [],
  };

  if (opts.aggregate) {
    buildAggregate(graph, d, soleAlias, defaultSystem, opts);
  } else {
    buildPerStep(graph, d, soleAlias, defaultSystem, opts);
  }
  return graph;
}

function systemFor(
  step: DistilledStep,
  laneSystem: Map<string, string>,
  alias: string,
  defaultSystem: string,
  opts: FromDistillationOptions,
): string {
  const url = typeof step.args.url === 'string' ? step.args.url : undefined;
  if (url) {
    try {
      const origin = new URL(url).origin;
      const mapped = opts.systemByOrigin?.[origin];
      if (mapped) laneSystem.set(alias, mapped);
    } catch {
      /* relative or malformed URL — keep lane */
    }
  }
  return laneSystem.get(alias) ?? defaultSystem;
}

function stepLabel(s: DistilledStep): string {
  const a = s.args;
  switch (s.catalog) {
    case 'form.fill': return `form.fill: ${asText(a.label)}`;
    case 'combobox.select': return `combobox.select: ${asText(a.label)} → ${asText(a.option)}`;
    case 'modal.save': return `modal.save: ${asText(a.button)}`;
    case 'recordPage.open': return `open ${asText(a.sobject) || 'record'}`;
    case 'nav.goto': return 'navigate';
    case 'ui.click': return `click: ${asText(a.name ?? a.label ?? a.text ?? a.testId)}`;
    default: return s.kind === 'raw' ? `raw: ${asText(a.api) || '?'}` : s.catalog;
  }
}

function buildPerStep(
  graph: ProcessGraph,
  d: Distillation,
  soleAlias: string,
  defaultSystem: string,
  opts: FromDistillationOptions,
): void {
  const laneSystem = new Map<string, string>();

  d.steps.forEach((s, i) => {
    const alias = s.actorAlias ?? soleAlias;
    const node: PNode = {
      id: `n${i}`,
      type: 'action',
      label: stepLabel(s),
      system: systemFor(s, laneSystem, alias, defaultSystem, opts),
      actor: alias,
      steps: { status: 'captured', stepIndexes: [i], ...(opts.journeyId ? { journeyId: opts.journeyId } : {}) },
      timing: { capturedMeanMs: Math.max(0, Math.round(s.durationMs)) },
      ...(typeof s.args.url === 'string' ? { url: s.args.url } : {}),
      ...(s.kind === 'raw' ? { notes: `unnamed raw step: ${JSON.stringify(s.args)}` } : {}),
      ...(s.catalog ? { catalog: s.catalog } : {}),
    };
    graph.nodes.push(node);

    if (i > 0) {
      const prev = d.steps[i - 1]!; // i > 0 just checked
      graph.edges.push({
        id: `e${i}`,
        from: `n${i - 1}`,
        to: `n${i}`,
        type: NAV_CATALOGS.has(s.catalog) ? 'navigates' : 'next',
        data: { deltaMs: Math.max(0, Math.round(s.startMs - prev.endMs)) },
      });
    }
  });

  // Handoff edges: a harvested record id touched by more than one actor.
  let h = 0;
  for (const rec of d.harvestedIds) {
    const touching = d.steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => JSON.stringify(s.args).includes(rec.id));
    const ordered = [...touching].sort((a, b) => a.s.startMs - b.s.startMs);
    for (let k = 1; k < ordered.length; k++) {
      const prevO = ordered[k - 1]!; // 1 <= k < length
      const curO = ordered[k]!;
      const prevActor = prevO.s.actorAlias ?? soleAlias;
      const curActor = curO.s.actorAlias ?? soleAlias;
      if (prevActor !== curActor) {
        graph.edges.push({
          id: `h${h++}`,
          from: `n${prevO.i}`,
          to: `n${curO.i}`,
          type: 'handoff',
          data: { recordRef: rec.id },
        });
      }
    }
  }
}

function buildAggregate(
  graph: ProcessGraph,
  d: Distillation,
  soleAlias: string,
  defaultSystem: string,
  opts: FromDistillationOptions,
): void {
  const laneSystem = new Map<string, string>();
  interface Agg { alias: string; catalog: string; system: string; samples: number[]; indexes: number[] }
  const activities = new Map<string, Agg>();
  const keyOf = (s: DistilledStep) => `${s.actorAlias ?? soleAlias}|${s.catalog}`;
  const nodeIdOf = (key: string) => `a_${key.replace(/[^a-z0-9]+/g, '_')}`;

  d.steps.forEach((s, i) => {
    const alias = s.actorAlias ?? soleAlias;
    const system = systemFor(s, laneSystem, alias, defaultSystem, opts);
    const key = keyOf(s);
    if (!activities.has(key)) activities.set(key, { alias, catalog: s.catalog, system, samples: [], indexes: [] });
    const a = activities.get(key)!;
    a.samples.push(Math.max(0, Math.round(s.durationMs)));
    a.indexes.push(i);
  });

  graph.nodes.push({ id: 'start', type: 'start', label: '' });
  for (const [key, a] of activities) {
    graph.nodes.push({
      id: nodeIdOf(key),
      type: 'action',
      label: a.catalog,
      actor: a.alias,
      system: a.system,
      catalog: a.catalog,
      steps: { status: 'captured', stepIndexes: a.indexes },
      timing: { capturedMeanMs: mean(a.samples), capturedP95Ms: p95(a.samples) },
    });
  }
  graph.nodes.push({ id: 'end', type: 'end', label: '' });

  const df = new Map<string, { from: string; to: string; count: number; gaps: number[] }>();
  const bump = (from: string, to: string, gap: number) => {
    const k = `${from}→${to}`;
    if (!df.has(k)) df.set(k, { from, to, count: 0, gaps: [] });
    const e = df.get(k)!;
    e.count += 1;
    e.gaps.push(Math.max(0, Math.round(gap)));
  };

  if (d.steps.length) {
    bump('start', nodeIdOf(keyOf(d.steps[0]!)), 0); // guarded by d.steps.length
    for (let i = 1; i < d.steps.length; i++) {
      bump(nodeIdOf(keyOf(d.steps[i - 1]!)), nodeIdOf(keyOf(d.steps[i]!)), d.steps[i]!.startMs - d.steps[i - 1]!.endMs);
    }
    bump(nodeIdOf(keyOf(d.steps[d.steps.length - 1]!)), 'end', 0);
  }

  let i = 0;
  for (const e of df.values()) {
    graph.edges.push({
      id: `df${i++}`,
      from: e.from,
      to: e.to,
      type: 'next',
      data: { frequency: e.count, meanMs: mean(e.gaps) },
    });
  }
}
