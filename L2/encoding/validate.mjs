#!/usr/bin/env node
/**
 * Validator for salesforce-mcp checkpoint batches (L2/encoding/batch-*.json).
 *
 * Enforces the substrate write contract BEFORE any atom reaches the server:
 *  - JSON shape: { batch, description, atoms:[{atom,payload}], edges:[{type,source,target}] }
 *  - id grammar: v1.<type>.<id>, type in the allowed set, id [a-z][a-z0-9_]{0,63}
 *  - payload: present, single-line, <= 4096 chars
 *  - fact names: must contain a structural double underscore (v2 grammar)
 *  - no numbered suffixes (_v2, _1 style)
 *  - every atom has >= 1 member_of edge to a hub IN ITS OWN batch
 *  - every edge endpoint resolves: same-batch atom (with payload), earlier-batch atom,
 *    or resident seed hub (WARN if an unknown v1.other.hub_* — must be verified resident)
 *  - edge types in the allowed set
 * Exit 0 = publishable; exit 1 = defects found.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional argv dir lets tests validate generated batches in a scratch copy.
const dir = process.argv[2] ? resolve(process.argv[2]) : dirname(fileURLToPath(import.meta.url));
const TYPES = ['fact', 'state', 'event', 'relation', 'procedure', 'domain', 'task', 'other'];
const EDGE_TYPES = ['references', 'depends_on', 'supersedes', 'constrains', 'member_of', 'derived_from', 'produced_by'];
const RESIDENT_SEEDS = new Set([
  'v1.other.hub_substrate_concepts',
  'v1.other.hub_substrate_invariants',
  'v1.other.hub_corrections',
  'v1.other.hub_decisions',
]);
const ID_RE = /^v1\.([a-z]+)\.([a-z][a-z0-9_]{0,63})$/;
const NUMBERED_SUFFIX_RE = /_(v)?\d+$/;
const DT_SUFFIX_RE = /_dt_\d{4}_\d{2}_\d{2}$/;

// batch-NN.json (hand-authored) and batch-rec-<id>.json (pipeline-generated,
// sorted after the numbered batches so their edges may target earlier atoms).
const files = readdirSync(dir).filter((f) => /^batch-[a-z0-9-]+\.json$/.test(f)).sort();
const errors = [];
const warnings = [];
const seen = new Set(RESIDENT_SEEDS);
let totalAtoms = 0;
let totalEdges = 0;
const typeCounts = {};
const edgeTypeCounts = {};

for (const file of files) {
  let doc;
  try {
    doc = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch (e) {
    errors.push(`${file}: JSON parse failed: ${e.message}`);
    continue;
  }
  const atoms = doc.atoms ?? [];
  const edges = doc.edges ?? [];
  const inBatch = new Set();

  for (const a of atoms) {
    const name = typeof a === 'string' ? a : a.atom;
    const payload = typeof a === 'string' ? undefined : a.payload;
    const m = ID_RE.exec(name ?? '');
    if (!m) { errors.push(`${file}: bad id grammar: ${name}`); continue; }
    const [, type, id] = m;
    if (!TYPES.includes(type)) errors.push(`${file}: unknown type '${type}' in ${name}`);
    if (NUMBERED_SUFFIX_RE.test(id) && !DT_SUFFIX_RE.test(id)) errors.push(`${file}: numbered suffix forbidden: ${name}`);
    if (type === 'fact' && !id.includes('__')) errors.push(`${file}: legacy fact grammar (no '__'): ${name}`);
    if (payload === undefined || payload === null || payload === '') errors.push(`${file}: missing payload: ${name}`);
    else {
      if (/[\r\n]/.test(payload)) errors.push(`${file}: payload has line breaks: ${name}`);
      if (payload.length > 4096) errors.push(`${file}: payload ${payload.length} > 4096: ${name}`);
    }
    if (seen.has(name) || inBatch.has(name)) warnings.push(`${file}: duplicate atom declaration: ${name}`);
    inBatch.add(name);
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    totalAtoms++;
  }

  const hubEdged = new Set();
  for (const e of edges) {
    if (!EDGE_TYPES.includes(e.type)) errors.push(`${file}: unknown edge type '${e.type}'`);
    for (const end of [e.source, e.target]) {
      if (inBatch.has(end) || seen.has(end)) continue;
      if (/^v1\.other\.hub_/.test(end)) warnings.push(`${file}: edge -> hub not in batches: ${end} (verify resident)`);
      else errors.push(`${file}: dead edge endpoint (silently dropped by server): ${end}`);
    }
    if (e.type === 'member_of' && /^v1\.other\.hub_/.test(e.target ?? '')) hubEdged.add(e.source);
    if (e.type === 'member_of' && /^v1\.domain\./.test(e.target ?? '')) hubEdged.add(e.source); // hubs belong to domain
    edgeTypeCounts[e.type] = (edgeTypeCounts[e.type] ?? 0) + 1;
    totalEdges++;
  }
  for (const name of inBatch) {
    if (!hubEdged.has(name) && !/^v1\.(other|domain)\./.test(name)) {
      errors.push(`${file}: atom lacks member_of hub edge in its own batch: ${name}`);
    }
  }
  for (const name of inBatch) seen.add(name);
}

const ratio = totalAtoms ? (totalEdges / totalAtoms).toFixed(2) : '0';
console.log(`files: ${files.length}, atoms: ${totalAtoms}, edges: ${totalEdges}, edges/atoms: ${ratio}`);
console.log('atom types:', JSON.stringify(typeCounts));
console.log('edge types:', JSON.stringify(edgeTypeCounts));
if (totalEdges < totalAtoms) errors.push(`edge floor violated: edges (${totalEdges}) < atoms (${totalAtoms})`);
else if (totalEdges < 2 * totalAtoms) warnings.push(`edge target missed: edges (${totalEdges}) < 2x atoms (${2 * totalAtoms})`);
for (const w of warnings) console.log('WARN', w);
for (const e of errors) console.log('ERROR', e);
console.log(errors.length ? `RESULT: ${errors.length} error(s) — NOT publishable` : 'RESULT: publishable');
process.exit(errors.length ? 1 : 0);
