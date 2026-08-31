/**
 * PG-4 — graph → substrate batch (design doc §3.6). Emits a validator-clean
 * checkpoint batch making the process queryable in memory:
 *   v1.procedure.process_<id>__graph    (compact structural JSON payload)
 *   v1.fact.process_<id>__coverage      (systems/policies/actors/records/denials)
 * Review-then-publish, same rule as settle contracts: this file NEVER
 * checkpoints anything itself. Snapshots (dataURLs), canvas positions, and
 * notes are stripped from the payload — they are planner/repo material, not
 * memory (and dataURLs would blow the 4096-char payload cap instantly).
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ProcessGraph } from './schema';
import { validateGraph } from './schema';

export const PAYLOAD_MAX = 4096;

export interface BatchDoc {
  batch: string;
  description: string;
  atoms: { atom: string; payload: string }[];
  edges: { type: string; source: string; target: string }[];
}

export function toBatch(graph: ProcessGraph): BatchDoc {
  const v = validateGraph(graph);
  if (!v.ok) throw new Error(`graph invalid:\n - ${v.errors.join('\n - ')}`);

  const graphAtom = `v1.procedure.process_${graph.id}__graph`;
  const coverageAtom = `v1.fact.process_${graph.id}__coverage`;

  const compact = {
    schema: graph.schema,
    id: graph.id,
    ...(graph.title ? { title: graph.title } : {}),
    systems: graph.systems,
    actors: graph.actors,
    nodes: graph.nodes.map((n) => {
      const { pos: _pos, notes: _notes, snapshot, expects, ...rest } = n;
      return {
        ...rest,
        ...(snapshot ? { snapshot: { status: snapshot.status } } : {}),
        // Oracles are durable knowledge; run results are not (storage split).
        ...(expects ? { expects: expects.map(({ lastResult: _lastResult, ...x }) => x) } : {}),
      };
    }),
    edges: graph.edges,
  };
  const payload = JSON.stringify(compact);
  if (payload.length > PAYLOAD_MAX) {
    throw new Error(
      `process graph '${graph.id}' serializes to ${payload.length} chars (> ${PAYLOAD_MAX} payload cap) — ` +
        `split the process into smaller graphs or trim labels/args; the full graph stays in journeys/graphs/ regardless`,
    );
  }

  const systems = Object.entries(graph.systems)
    .map(([k, s]) => `${k}(${s.kind}${s.sessionPolicy ? `, max ${s.sessionPolicy.maxConcurrent} session` : ''})`)
    .join(', ');
  const actors = Object.entries(graph.actors).map(([a, p]) => `${a}→${p}`).join(', ');
  const denials = graph.edges
    .filter((e) => e.type === 'deny' || e.type === 'denied')
    .map((e) => e.data?.capability)
    .filter(Boolean);
  const records = [
    ...new Set([
      ...graph.edges.map((e) => e.data?.recordRef).filter(Boolean),
      ...graph.nodes.filter((n) => n.type === 'data').map((n) => n.label),
    ]),
  ];
  const journeys = [
    ...new Set(graph.nodes.map((n) => n.steps?.journeyId).filter((x): x is string => !!x)),
  ];

  const coverage =
    `Coverage of process ${graph.id}${graph.title ? ` ('${graph.title}')` : ''}: systems ${systems || '(none)'}; ` +
    `actors ${actors || '(none)'}; ${graph.nodes.length} nodes / ${graph.edges.length} edges; ` +
    `denials probed: ${denials.length ? denials.join(', ') : '(none)'}; ` +
    `shared records: ${records.length ? records.join(', ') : '(none)'}; ` +
    `journeys: ${journeys.length ? journeys.join(', ') : '(none yet — plan not captured)'}. ` +
    `Query this hub by system/actor/capability to find which processes touch them.`;

  return {
    batch: `graph-${graph.id.replace(/_/g, '-')}`,
    description:
      `Process graph '${graph.id}' encoded for memory (source of truth: journeys/graphs/${graph.id}.graph.json). ` +
      'REVIEW BEFORE PUBLISHING — the emitter never checkpoints directly.',
    atoms: [
      { atom: graphAtom, payload },
      { atom: coverageAtom, payload: coverage },
    ],
    edges: [
      { type: 'member_of', source: graphAtom, target: 'v1.other.hub_sf_journeys' },
      { type: 'member_of', source: coverageAtom, target: 'v1.other.hub_sf_journeys' },
      { type: 'derived_from', source: coverageAtom, target: graphAtom },
    ],
  };
}

/** Write the batch file next to the hand-authored ones (review-then-publish). */
export function writeBatch(graph: ProcessGraph, dir = path.join('L2', 'encoding')): string {
  const doc = toBatch(graph);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `batch-${doc.batch}.json`);
  fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n');
  return file;
}
