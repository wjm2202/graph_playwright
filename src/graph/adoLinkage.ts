/**
 * Cross-case linkage for ado:import (owner, 2026-09-04): "sequential cases
 * are not created as a complete journey — they are interpreted as isolated
 * journeys". The export carries NO ordering cue beyond the language of the
 * steps, so this module reads every case and works out, from the words,
 * which business records each case CREATES and which it USES — then links a
 * case that uses a record it never created to the case that created it.
 *
 * Detect + flag only (owner decision): nothing here rewrites a graph. The
 * result is a per-case data profile, the links between cases, the ordered
 * chains they form, and one flag per finding for grillme / the human. The
 * same verb→port and object guesses as fromAdo.ts are used, so a link here
 * is exactly the dataflow the drafted graphs would fail on
 * (compose.ts dataflowHealth: "nothing defines it before this point").
 *
 * Pure: no fs, no schema — safe to inline in the planner build.
 */
import { objectOf, slug, stripRole, verbIo, type AdoCase } from './fromAdo';
import type { DataIo } from './schema';

export interface DataTouch {
  /** Normalised record key (lower_snake, singular): 'lead', 'account'. */
  object: string;
  io: DataIo;
  /** 0-based step index inside the case. */
  step: number;
  /** The action (or expected) phrase the touch was read from. */
  phrase: string;
}

export interface CaseProfile {
  index: number;
  id?: string;
  title: string;
  touches: DataTouch[];
  /** Records this case creates (produces). */
  produces: string[];
  /** Records this case reads or updates. */
  consumes: string[];
  /** Consumed/updated BEFORE any step of this case creates them — the
   *  hand-off the case expects from somewhere else. */
  unbound: string[];
  /** Records the language calls pre-existing ("an existing lead") — external, not a hand-off. */
  existing: string[];
  /** Other cases this case names in its steps (ADO ids / "previous test case"). */
  mentions: { ids: string[]; previous: boolean };
}

export type LinkConfidence = 'stated' | 'dataflow' | 'weak';

export interface CaseLink {
  /** Index of the case that must run FIRST. */
  from: number;
  /** Index of the case that continues from it. */
  to: number;
  /** Records handed over (empty for a purely stated reference). */
  objects: string[];
  confidence: LinkConfidence;
  reason: string;
}

export interface LinkageResult {
  profiles: CaseProfile[];
  links: CaseLink[];
  /** Ordered runs of case indexes joined by links (singletons omitted). */
  chains: number[][];
  /** Per case index: what grillme / the human should be told. */
  flags: Record<number, string[]>;
}

const CREATED_RE = /\b([a-z][a-z ]{1,24}?)\s+(?:record\s+)?(?:is|are|was|were|gets?|has\s+been|have\s+been)\s+(?:successfully\s+)?(?:created|saved|generated|inserted|persisted)\b/gi;
const EXISTING_RE = /\b(?:existing|pre-?existing|already\s+created)\s+((?:[a-z]+\s*){1,3}?)(?=\s+records?\b|\s*[,.;:]|\s+(?:in|on|for|with|from|that|which|to|and|at|is|are|was|were)\b|\s*$)/gi;
/** Verbs that NEED the named record even though fromAdo's verbIo calls them
 *  'produces' (convert the lead → the lead must exist; what gets produced is
 *  named by the expected result, e.g. "Account is created"). */
const NEEDS_RECORD_RE = /^(?:convert|submit)\b/i;
const PREVIOUS_RE = /\b(?:previous|prior|preceding|earlier|last)\s+(?:test\s*)?case\b|\bcreated\s+in\s+(?:the\s+)?(?:previous|prior|earlier|last)\s+(?:test|test\s*case|tc)\b/i;
const CASE_ID_RE = /(?:\b(?:tc|test\s*case|case)\s*[-_ ]?\s*|#\s*)(\d{2,})\b/gi;
/** "Verify Prospect Account is created" — the verb reads as a check, but the
 *  sentence PROVES a creation; count it as a produce, not a hand-off. */
const SELF_CREATED_RE = /\b(?:is|are|was|were|gets?|has\s+been|have\s+been)\s+(?:successfully\s+)?(?:created|saved|generated|inserted)\b/i;

/** 'Leads' → 'lead', 'Prospect Accounts' → 'prospect_account'. */
export function objectKey(name: string): string {
  const key = slug(
    name
      .replace(/^(?:the\s+|an?\s+|new\s+|existing\s+|pre-?existing\s+|already\s+created\s+|same\s+)+/i, '')
      .replace(/\s+records?\s*$/i, ''),
  );
  if (key.length > 4 && key.endsWith('ies')) return `${key.slice(0, -3)}y`;
  if (key.length > 3 && key.endsWith('s') && !key.endsWith('ss') && !key.endsWith('us')) return key.slice(0, -1);
  return key;
}

/** What one case creates and uses — read from its steps' language. */
export function profileCase(tc: AdoCase, index: number): CaseProfile {
  const touches: DataTouch[] = [];
  const existing = new Set<string>();
  const ids = new Set<string>();
  let previous = false;

  tc.steps.forEach((step, i) => {
    const action = stripRole(step.action.trim());
    const expected = (step.expected ?? '').trim();
    for (const text of [action, expected]) {
      for (const m of text.matchAll(EXISTING_RE)) {
        const key = objectKey(m[1] ?? '');
        if (key) existing.add(key);
      }
      for (const m of text.matchAll(CASE_ID_RE)) if (m[1]) ids.add(m[1]);
      if (PREVIOUS_RE.test(text)) previous = true;
    }

    const object = objectOf(action);
    if (object) {
      const key = objectKey(object);
      const io: DataIo = SELF_CREATED_RE.test(action) ? 'produces'
        : NEEDS_RECORD_RE.test(action) ? 'updates'
        : verbIo(action);
      if (key) touches.push({ object: key, io, step: i, phrase: action });
    }
    // The expected result can NAME what got created ("Account and Contact
    // are created") — each is a produce of this step.
    for (const m of expected.matchAll(CREATED_RE)) {
      for (const part of (m[1] ?? '').split(/\s*(?:,|\band\b|&)\s*/i)) {
        const key = objectKey(part.replace(/^(?:the|a|an|new)\s+/i, ''));
        if (!key || key === 'record' || key === 'it') continue;
        if (!touches.some((t) => t.step === i && t.object === key && t.io === 'produces')) {
          touches.push({ object: key, io: 'produces', step: i, phrase: expected });
        }
      }
    }
  });

  const produced = new Set<string>();
  const produces: string[] = [];
  const consumes: string[] = [];
  const unbound: string[] = [];
  for (const t of touches) {
    if (t.io === 'produces') {
      if (!produced.has(t.object)) produces.push(t.object);
      produced.add(t.object);
    } else {
      if (!consumes.includes(t.object)) consumes.push(t.object);
      if (!produced.has(t.object) && !existing.has(t.object) && !unbound.includes(t.object)) unbound.push(t.object);
    }
  }
  const id = tc.id?.trim();
  return {
    index,
    ...(id ? { id } : {}),
    title: tc.title,
    touches,
    produces,
    consumes,
    unbound,
    existing: [...existing],
    mentions: { ids: [...ids].filter((x) => x !== id), previous },
  };
}

/**
 * Link every case that uses a record it never creates to the case that
 * creates it. Row order is the only tie-breaker: the NEAREST EARLIER
 * producer wins ('dataflow'); a producer that only appears LATER in the
 * sheet is still linked, but 'weak' — the order may be wrong. An explicit
 * mention (ADO id, "previous test case") is 'stated'.
 */
export function linkCases(cases: AdoCase[]): LinkageResult {
  const profiles = cases.map((tc, i) => profileCase(tc, i));
  const links: CaseLink[] = [];
  const flags: Record<number, string[]> = {};
  const say = (i: number, text: string) => (flags[i] ??= []).push(text);
  const byId = new Map(profiles.filter((p) => p.id).map((p) => [p.id!, p.index]));
  const label = (p: CaseProfile) => `#${p.index}${p.id ? ` (${p.id})` : ''} '${p.title}'`;
  const addLink = (link: CaseLink) => {
    const same = links.find((l) => l.from === link.from && l.to === link.to);
    if (!same) { links.push(link); return; }
    for (const o of link.objects) if (!same.objects.includes(o)) same.objects.push(o);
    if (rank(link.confidence) > rank(same.confidence)) { same.confidence = link.confidence; same.reason = link.reason; }
  };

  for (const p of profiles) {
    // Stated references first — the author told us.
    for (const id of p.mentions.ids) {
      const from = byId.get(id);
      if (from === undefined || from === p.index) continue;
      addLink({ from, to: p.index, objects: [], confidence: 'stated', reason: `its steps name test case ${id}` });
      say(p.index, `continues from ${label(profiles[from]!)} — its steps name test case ${id}`);
    }
    if (p.mentions.previous && p.index > 0) {
      const from = p.index - 1;
      addLink({ from, to: p.index, objects: [], confidence: 'stated', reason: 'its steps say "previous test case"' });
      say(p.index, `continues from ${label(profiles[from]!)} — its steps say "previous test case" (row order assumed)`);
    }

    // Dataflow: each unbound record → who creates it?
    for (const object of p.unbound) {
      const earlier = profiles.filter((q) => q.index < p.index && q.produces.includes(object));
      const later = profiles.filter((q) => q.index > p.index && q.produces.includes(object));
      const touch = p.touches.find((t) => t.object === object && t.io !== 'produces')!;
      const use = `${touch.io} '${object}' ('${trunc(touch.phrase)}') but nothing in the case creates it`;
      if (earlier.length) {
        const from = earlier[earlier.length - 1]!;
        addLink({ from: from.index, to: p.index, objects: [object], confidence: 'dataflow', reason: `${label(p)} uses '${object}' created by ${label(from)}` });
        const others = earlier.slice(0, -1);
        say(p.index, `${use} — continuation of ${label(from)}, which creates it${others.length ? ` (also created by ${others.map(label).join(', ')} — nearest earlier chosen)` : ''}`);
      } else if (later.length) {
        const from = later[0]!;
        addLink({ from: from.index, to: p.index, objects: [object], confidence: 'weak', reason: `${label(p)} uses '${object}' that only ${label(from)} creates, LATER in the sheet` });
        say(p.index, `${use} — only ${label(from)} creates it, and that case comes LATER in the sheet; row order may be wrong, or the record is pre-existing`);
      } else {
        say(p.index, `${use} — no case in this import creates it; pre-existing data (mark the data node external: true) or a case missing from the export`);
      }
    }
  }

  // Produced but never handed on: worth a note, not a link.
  for (const p of profiles) {
    for (const object of p.produces) {
      const users = links.filter((l) => l.from === p.index && l.objects.includes(object));
      if (!users.length && !p.consumes.includes(object)) {
        say(p.index, `creates '${object}' that no other case uses — the end of a journey, or its successor was not exported`);
      }
    }
  }

  return { profiles, links, chains: chainsOf(profiles.length, links), flags };
}

function rank(c: LinkConfidence): number {
  return c === 'stated' ? 3 : c === 'dataflow' ? 2 : 1;
}

/** Connected components of the link graph, each listed in run order
 *  (topological where the links say so, sheet order otherwise). */
function chainsOf(n: number, links: CaseLink[]): number[][] {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const l of links) parent[find(l.from)] = find(l.to);
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) (groups.get(find(i)) ?? groups.set(find(i), []).get(find(i))!).push(i);

  const chains: number[][] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Kahn over the members' links; ties broken by sheet order so a chain
    // reads predictably even when the links under-determine it.
    const inDeg = new Map(members.map((m) => [m, 0]));
    const out = new Map<number, number[]>(members.map((m) => [m, []]));
    const inGroup = new Set(members);
    const seen = new Set<string>();
    for (const l of links) {
      if (!inGroup.has(l.from) || !inGroup.has(l.to) || seen.has(`${l.from}>${l.to}`)) continue;
      seen.add(`${l.from}>${l.to}`);
      out.get(l.from)!.push(l.to);
      inDeg.set(l.to, (inDeg.get(l.to) ?? 0) + 1);
    }
    const ready = members.filter((m) => inDeg.get(m) === 0).sort((a, b) => a - b);
    const order: number[] = [];
    while (ready.length) {
      const m = ready.shift()!;
      order.push(m);
      for (const t of out.get(m)!) {
        inDeg.set(t, inDeg.get(t)! - 1);
        if (inDeg.get(t) === 0) { ready.push(t); ready.sort((a, b) => a - b); }
      }
    }
    // A cycle (weak links both ways) leaves members unplaced — append in sheet order.
    for (const m of members) if (!order.includes(m)) order.push(m);
    chains.push(order);
  }
  return chains.sort((a, b) => a[0]! - b[0]!);
}

/** One line per chain for the CLI: "#0 → #2 → #3  (lead, account)". */
export function describeChains(r: LinkageResult): string[] {
  return r.chains.map((chain) => {
    const objects = new Set<string>();
    for (const l of r.links) if (chain.includes(l.from) && chain.includes(l.to)) l.objects.forEach((o) => objects.add(o));
    const weak = r.links.some((l) => chain.includes(l.from) && chain.includes(l.to) && l.confidence === 'weak');
    return `${chain.map((i) => `#${i}`).join(' → ')}${objects.size ? `  (${[...objects].join(', ')})` : ''}${weak ? '  ⚠ order uncertain' : ''}`;
  });
}

function trunc(s: string, n = 40): string {
  const t = s.trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}
