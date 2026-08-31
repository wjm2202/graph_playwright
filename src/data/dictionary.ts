/**
 * Data dictionary — classifies captured form fields so recordings become
 * re-runnable AUTOMATICALLY (the "I can't make the same lead twice" fix).
 *
 * Three classes:
 *  - identity        must be unique per run (duplicate rules bite otherwise)
 *                    → rewritten to {fake:<spec>} or {unique:<Label>}
 *  - identity_email  unique AND must be a safe address → {fake:email}
 *  - business        the scenario's substance (amounts, picklists, stages)
 *                    → kept literal, exactly as captured
 *
 * Resolution order: repo data-dictionary.json (label → class or
 * {class, fake}) overrides the built-in defaults; anything not covered is
 * classified by heuristics and FLAGGED so a one-time human confirmation can
 * be added to the file — the dictionary compounds like the step grammar.
 */

import * as fs from 'fs';
import * as path from 'path';
import { compact } from '../utils/compact';

export type FieldClass = 'identity' | 'identity_email' | 'business';

export interface Classification {
  cls: FieldClass;
  /** factory spec for identity fields with a natural generator. */
  fake?: string;
  source: 'dictionary' | 'heuristic';
}

const DEFAULTS: Record<string, { cls: FieldClass; fake?: string }> = {
  'first name': { cls: 'identity', fake: 'person.firstName' },
  'last name': { cls: 'identity', fake: 'person.lastName' },
  'full name': { cls: 'identity', fake: 'person.fullName' },
  'company': { cls: 'identity', fake: 'company' },
  'account name': { cls: 'identity', fake: 'company' },
  'opportunity name': { cls: 'identity' },
  'email': { cls: 'identity_email' },
  'phone': { cls: 'business' },
  'mobile': { cls: 'business' },
  'website': { cls: 'business' },
  'title': { cls: 'business' },
  'amount': { cls: 'business' },
  'lead source': { cls: 'business' },
  'stage': { cls: 'business' },
  'status': { cls: 'business' },
  'street': { cls: 'identity', fake: 'address.street' },
  'city': { cls: 'business' },
  'subject': { cls: 'business' },
  'description': { cls: 'business' },
};

export interface Dictionary {
  entries: Record<string, { cls: FieldClass; fake?: string }>;
  sourceFile?: string;
}

/** Load defaults merged with the repo's data-dictionary.json (if present). */
export function loadDictionary(file = path.resolve('data-dictionary.json')): Dictionary {
  const entries = { ...DEFAULTS };
  let sourceFile: string | undefined;
  if (fs.existsSync(file)) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [label, raw] of Object.entries(doc)) {
      if (label.startsWith('_')) continue; // _comment and friends are annotations
      const key = normalize(label);
      if (typeof raw === 'string') {
        if (raw !== 'identity' && raw !== 'identity_email' && raw !== 'business') {
          throw new Error(`data-dictionary.json: '${label}' has unknown class '${raw}' (identity|identity_email|business)`);
        }
        entries[key] = { cls: raw };
      } else if (raw && typeof raw === 'object') {
        const o = raw as { class?: FieldClass; fake?: string };
        if (!o.class || !['identity', 'identity_email', 'business'].includes(o.class)) {
          throw new Error(`data-dictionary.json: '${label}' needs class identity|identity_email|business`);
        }
        entries[key] = { cls: o.class, ...(o.fake ? { fake: o.fake } : {}) };
      }
    }
    sourceFile = file;
  }
  return compact({ entries, sourceFile });
}

export function normalize(label: string): string {
  return label.trim().toLowerCase().replace(/\s*\*$/, '').replace(/\s+/g, ' ');
}

/** Classify a captured form label. Dictionary wins; heuristics fill the rest. */
export function classify(label: string, dict: Dictionary): Classification {
  const key = normalize(label);
  const hit = dict.entries[key];
  if (hit) return { ...hit, source: 'dictionary' };

  if (/e-?mail/.test(key)) return { cls: 'identity_email', source: 'heuristic' };
  if (/\b(first name)\b/.test(key)) return { cls: 'identity', fake: 'person.firstName', source: 'heuristic' };
  if (/\b(last name|surname)\b/.test(key)) return { cls: 'identity', fake: 'person.lastName', source: 'heuristic' };
  if (/\b(company|account)\b/.test(key)) return { cls: 'identity', fake: 'company', source: 'heuristic' };
  if (/\bname\b/.test(key)) return { cls: 'identity', source: 'heuristic' };
  return { cls: 'business', source: 'heuristic' };
}

/** The placeholder a classified capture rewrites to (undefined = keep literal). */
export function placeholderFor(label: string, c: Classification): string | undefined {
  if (c.cls === 'identity_email') return '{fake:email}';
  if (c.cls === 'identity') {
    if (c.fake) return `{fake:${c.fake}}`;
    const base = normalize(label).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'value';
    return `{unique:${base}}`;
  }
  return undefined;
}
