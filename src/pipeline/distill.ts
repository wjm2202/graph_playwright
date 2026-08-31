/**
 * R3 — distiller: RawEvent[] → DistilledStep[] via the starter action grammar
 * (design doc §7.1). JSON-bound knowledge only; selectors/waits stay in the
 * step catalog the generator scaffolds.
 *
 * Starter grammar (each recognizer names the catalog vocabulary it feeds):
 *   click role=combobox "X" → click role=option "Y"   ⇒ combobox.select(X, Y)
 *   fill  label "X" = v                               ⇒ form.fill(X, v)
 *   nav   /lightning/r/<SObject>/<id>/view            ⇒ recordPage.open(SObject, id)
 *   click role=button "Save|Submit…" (+ network burst)⇒ modal.save(name)
 *   click any parseable role/label/text/testid target ⇒ ui.click(target)
 *   anything else                                     ⇒ RAW, flagged 'name-me'
 * Every human naming of a raw step grows the grammar — that is the compounding
 * labour reduction.
 *
 * Settle attribution: network events starting inside (action.start, nextAction.start]
 * belong to that action; the step's settle signal is the burst's URL FAMILY +
 * method (never exact URLs/counts as assertions — founding doc §3.4), and the
 * step duration runs action start → max(action end, burst end) so learned
 * baselines measure what the human actually waited.
 *
 * v1 limitation (trace-based): DOM settle signals (spinner/toast) and response
 * payloads are not in the trace — they arrive with CDP capture (sprint S1).
 * Harvested record ids come from nav URLs for now and are surfaced for
 * flag-level parameterization, not silently rewritten.
 */

import type { RawEvent } from './traceReader';
import { parseInternalSelector, type ParsedSelector } from './traceReader';
import { classify, loadDictionary, placeholderFor, type Dictionary } from '../data/dictionary';
import { asText } from '../utils/text';

export type NetworkFamily = 'aura' | 'services_data' | 'lightning_nav' | 'other';

export interface SettleSignal {
  family: NetworkFamily;
  method: string;
  /** Observed burst size — recorded for evidence, never asserted in specs. */
  observedCount: number;
}

export interface DistilledStep {
  kind: 'step' | 'raw';
  /** Catalog entry for recognized steps; 'raw.name_me' for unrecognized. */
  catalog: string;
  /** Set by the R6 stitcher for multi-actor journeys; defaults to 'main'. */
  actorAlias?: string;
  args: Record<string, unknown>;
  settle?: SettleSignal;
  startMs: number;
  endMs: number;
  durationMs: number;
  recognized: boolean;
  /** Indices into the source RawEvent[] (provenance for review/debug). */
  sourceEvents: number[];
  flag?: 'name-me';
}

export interface Distillation {
  steps: DistilledStep[];
  /** Salesforce record ids seen in nav URLs, for parameterization review. */
  harvestedIds: { id: string; sobject?: string; firstEvent: number }[];
  /** Human-readable notes: raw steps to name, ids left literal. */
  flags: string[];
}

const SF_ID_RE = /\b([a-zA-Z0-9]{18}|[a-zA-Z0-9]{15})\b/;
const RECORD_URL_RE = /\/lightning\/r\/([A-Za-z0-9_]+)\/([a-zA-Z0-9]{15,18})\/view/;
const SAVEISH_RE = /^(save|submit|confirm|done|next|finish)/i;

export function networkFamily(url: string): NetworkFamily {
  if (/\/(aura|sfsites\/aura)\b/.test(url)) return 'aura';
  if (url.includes('/services/data/')) return 'services_data';
  if (url.includes('/lightning/')) return 'lightning_nav';
  return 'other';
}

export function distill(events: RawEvent[]): Distillation {
  const steps: DistilledStep[] = [];
  const harvested: Distillation['harvestedIds'] = [];
  const flags: string[] = [];

  // Actions/navs drive the walk; network events attach by time window.
  const actionable = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.kind === 'action' || e.kind === 'nav');
  const network = events
    .map((e, index) => ({ e, index }))
    .filter(({ e }) => e.kind === 'network');

  const burstFor = (start: number, nextStart: number) =>
    network.filter(({ e }) => e.startMs > start && e.startMs <= nextStart);

  for (let i = 0; i < actionable.length; i++) {
    const { e, index } = actionable[i]!; // 0 <= i < length
    const nextStart = actionable[i + 1]?.e.startMs ?? Number.POSITIVE_INFINITY;

    // recordPage.open — navigation to a record view.
    if (e.kind === 'nav') {
      const m = RECORD_URL_RE.exec(e.url);
      if (m) {
        const [, sobject = '', id = ''] = m;
        harvested.push({ id, sobject, firstEvent: index });
        steps.push(step('recordPage.open', { sobject, id }, e, [index]));
      } else {
        steps.push(step('nav.goto', { url: e.url }, e, [index]));
      }
      continue;
    }
    if (e.kind !== 'action') continue; // only actions remain past this point

    const sel: ParsedSelector | undefined = e.selector ? parseInternalSelector(e.selector) : undefined;

    // combobox.select — combobox click followed by an option click.
    const nextEntry = actionable[i + 1];
    const nextEv = nextEntry?.e;
    if (
      e.api === 'click' && sel?.kind === 'role' && sel.role === 'combobox' &&
      nextEv?.kind === 'action' && nextEv.api === 'click' && nextEv.selector
    ) {
      const nextSel = parseInternalSelector(nextEv.selector);
      if (nextSel.kind === 'role' && nextSel.role === 'option') {
        const merged = { startMs: e.startMs, endMs: nextEv.endMs };
        steps.push(
          step('combobox.select', { label: sel.name ?? '', option: nextSel.name ?? '' }, merged, [index, nextEntry!.index]), // nextEv guard implies nextEntry
        );
        i += 1; // consume the option click
        continue;
      }
    }

    // form.fill — label-addressed fill.
    if (e.api === 'fill' && sel?.kind === 'label') {
      steps.push(step('form.fill', { label: sel.text, value: e.value ?? '' }, e, [index]));
      continue;
    }

    // modal.save — save-ish button; the attributed burst becomes the settle signal.
    if (e.api === 'click' && sel?.kind === 'role' && sel.role === 'button' && sel.name && SAVEISH_RE.test(sel.name)) {
      const burst = burstFor(e.startMs, nextStart);
      const s = step('modal.save', { button: sel.name }, e, [index, ...burst.map((b) => b.index)]);
      if (burst.length) {
        const primary = burst.find(({ e: n }) => n.kind === 'network' && networkFamily(n.url) === 'aura') ?? burst[0]!; // burst.length checked above
        const pn = primary.e as Extract<RawEvent, { kind: 'network' }>;
        s.settle = { family: networkFamily(pn.url), method: pn.method, observedCount: burst.length };
        s.endMs = Math.max(s.endMs, ...burst.map(({ e: n }) => n.endMs));
        s.durationMs = s.endMs - s.startMs;
      }
      steps.push(s);
      continue;
    }

    // ui.click — any semantically addressable target.
    if (e.api === 'click' && sel && sel.kind !== 'css' && sel.kind !== 'other') {
      const target =
        sel.kind === 'role' ? { role: sel.role, name: sel.name } :
        sel.kind === 'label' ? { label: sel.text } :
        sel.kind === 'text' ? { text: sel.text } : { testId: sel.id };
      steps.push(step('ui.click', target, e, [index]));
      continue;
    }

    // RAW fallback — flagged for naming; naming it grows the grammar.
    const raw = step('raw.name_me', { api: e.api, selector: e.selector, value: e.value }, e, [index]);
    raw.kind = 'raw';
    raw.recognized = false;
    raw.flag = 'name-me';
    steps.push(raw);
    flags.push(`step ${steps.length - 1}: unrecognized ${e.api} on ${e.selector ?? '(no selector)'} — name it to grow the grammar`);
  }

  // Ids inside args stay literal in v1; surface them for review.
  for (const h of harvested) {
    if (SF_ID_RE.test(h.id)) {
      flags.push(`literal record id ${h.id}${h.sobject ? ` (${h.sobject})` : ''} — parameterize when seed provenance is known (CDP capture, sprint S1)`);
    }
  }

  parameterizeFills(steps, flags);

  return { steps, harvestedIds: harvested, flags };
}

/**
 * Data auto-parameterization: captured form values classified by the data
 * dictionary. Identity fields become generators ({fake:}/{unique:}) so the
 * SAME recording re-runs forever — Salesforce duplicate rules never see the
 * same lead twice. Business values stay exactly as the human typed them.
 * Heuristic classifications are flagged for one-time confirmation in
 * data-dictionary.json.
 */
function parameterizeFills(steps: DistilledStep[], flags: string[], dict?: Dictionary): void {
  let dictionary: Dictionary;
  try {
    dictionary = dict ?? loadDictionary();
  } catch (e) {
    flags.push(`data-dictionary.json unreadable (${(e as Error).message}) — captured values left literal`);
    return;
  }
  for (const s of steps) {
    if (s.kind !== 'step' || s.catalog !== 'form.fill') continue;
    const label = asText(s.args.label);
    const captured = asText(s.args.value);
    if (!label || captured.startsWith('{')) continue; // already a placeholder
    const c = classify(label, dictionary);
    const placeholder = placeholderFor(label, c);
    if (!placeholder) continue; // business value: the scenario keeps its substance
    s.args.value = placeholder;
    flags.push(
      `data: '${label}' captured '${captured}' → ${placeholder}` +
        (c.source === 'heuristic' ? ' (heuristic — confirm once in data-dictionary.json to silence)' : ''),
    );
  }
}

function step(
  catalog: string,
  args: Record<string, unknown>,
  e: { startMs: number; endMs: number },
  sourceEvents: number[],
): DistilledStep {
  return {
    kind: 'step',
    catalog,
    args,
    startMs: e.startMs,
    endMs: e.endMs,
    durationMs: e.endMs - e.startMs,
    recognized: true,
    sourceEvents,
  };
}
