/**
 * PG-1 — mermaid export: a ~free static picture of any ProcessGraph for
 * GitHub/docs/chat. Deliberately a PICTURE format only — the system of record
 * is the .graph.json; the interactive layer is the cytoscape planner.
 */

import type { ProcessGraph } from './schema';

export function toMermaid(graph: ProcessGraph): string {
  const lines: string[] = ['flowchart LR'];

  const bySystem = new Map<string, string[]>();
  const loose: string[] = [];
  for (const n of graph.nodes) {
    const shape = nodeShape(n.type, n.id, nodeLabel(graph, n.id));
    if (n.system) {
      if (!bySystem.has(n.system)) bySystem.set(n.system, []);
      bySystem.get(n.system)!.push(shape);
    } else {
      loose.push(shape);
    }
  }
  for (const [sysId, nodes] of bySystem) {
    const sys = graph.systems[sysId];
    lines.push(`  subgraph ${sysId}[${esc(sys?.label ?? sysId)}]`);
    for (const n of nodes) lines.push(`    ${n}`);
    lines.push('  end');
  }
  for (const n of loose) lines.push(`  ${n}`);

  for (const e of graph.edges) {
    const target = graph.nodes.find((n) => n.id === e.to);
    const label = edgeLabel(e.type, e.label, e.data, target?.actor ?? target?.label);
    const arrow =
      e.type === 'deny' || e.type === 'denied' || e.type === 'requires' || e.type === 'asserts'
        ? '-.->'
        : e.type === 'handoff' || e.type === 'touches'
          ? '==>'
          : '-->';
    lines.push(`  ${e.from} ${arrow}${label ? `|${esc(label)}|` : ''} ${e.to}`);
  }

  return lines.join('\n') + '\n';
}

function nodeLabel(graph: ProcessGraph, id: string): string {
  const n = graph.nodes.find((x) => x.id === id)!;
  // A session's label IS its lane — appending the actor again is noise.
  const actor = n.actor && n.type !== 'session' ? ` (${n.actor})` : '';
  const base = n.label || n.type;
  const t = n.timing?.capturedP95Ms ?? n.timing?.capturedMeanMs;
  return `${base}${actor}${t ? ` · ${fmtMs(t)}` : ''}`;
}

function nodeShape(type: string, id: string, label: string): string {
  const l = esc(label);
  switch (type) {
    case 'start': return `${id}((start))`;
    case 'end': return `${id}((end))`;
    case 'decision': return `${id}{${l}}`;
    case 'checkpoint': return `${id}[[${l}]]`;
    case 'snapshot': return `${id}[(${l})]`;
    case 'session': return `${id}([${l}])`;
    case 'data': return `${id}[(${l})]`;
    case 'db': return `${id}[(${l})]`;
    case 'logger': return `${id}[/${l}/]`;
    case 'api': return `${id}{{${l}}}`;
    default: return `${id}[${l}]`;
  }
}

function edgeLabel(
  type: string,
  label: string | undefined,
  data: { deltaMs?: number; recordRef?: string; frequency?: number; meanMs?: number; capability?: string; catalog?: string; auth?: string } | undefined,
  targetIdentity?: string,
): string {
  const parts: string[] = [];
  // The arrow names WHO you become; the auth mechanism is panel detail.
  if (type === 'login_as') parts.push(`login as ${targetIdentity ?? '?'}`);
  if (type === 'does' && data?.catalog) parts.push(data.catalog);
  if (type === 'requires') parts.push('requires');
  if (type === 'asserts') parts.push('asserts');
  if (label) parts.push(label);
  if ((type === 'deny' || type === 'denied') && data?.capability) parts.push(`deny ${data.capability}`);
  if (type === 'handoff' && data?.recordRef) parts.push(`rec ${shorten(data.recordRef)}`);
  if (data?.frequency !== undefined) parts.push(`×${data.frequency}`);
  const ms = data?.deltaMs ?? data?.meanMs;
  if (ms !== undefined && ms > 0) parts.push(fmtMs(ms));
  return parts.join(' · ');
}

export function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function shorten(s: string): string {
  return s.length > 9 ? `${s.slice(0, 6)}…` : s;
}

function esc(s: string): string {
  return s.replace(/"/g, "'").replace(/[[\]{}|]/g, ' ').replace(/\s+/g, ' ').trim();
}
