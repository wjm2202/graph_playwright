/**
 * Journey Studio link contract — the ONE thing both sides must agree on
 * (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §4).
 *
 * Journey Studio names a guide by the `objective` in a Playwright annotation
 * `{ type: 'guide', description: <JSON> }`, and deep-links to it as
 * `studio.html?batch=<batch>&slug=<objective>`. We declare the objective
 * ourselves rather than letting Journey Studio derive it from the test title:
 * the planner has to build the link BEFORE it reads Journey Studio's output,
 * and derived slugs get auto-numbered on collision (`-2`, `-3`), which makes
 * a link guessable only after the fact.
 *
 * Journey Studio THROWS on a duplicate explicit slug, and the persona matrix
 * expands one graph into several tests — so the variant is always part of
 * the slug, even for `default`.
 *
 * PURE: no fs, no Playwright import. Unit-tested in tests/unit/studio-slug.spec.ts.
 */

/** Journey Studio's own limit (lib/timeline.mjs slugify truncates to 60). */
export const SLUG_MAX = 60;

/** Default Journey Studio serve address (bin/journey-studio.mjs: port 8777, host 127.0.0.1). */
export const DEFAULT_STUDIO_URL = 'http://127.0.0.1:8777';

/** `[a-z0-9_-]` only; runs of anything else collapse to one `-`. */
export function slugPart(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `salesforce/o2a_tc01` + `default` → `salesforce--o2a_tc01--default`
 * `salesforce/o2a_tc01` + `partner`  → `salesforce--o2a_tc01--partner`
 *
 * `--` is the structural separator (project, id, variant); a single `-`
 * is a word separator inside a part. Legacy refs without a project keep
 * two parts: `lead_to_customer--default`.
 *
 * Over-length slugs are cut from the MIDDLE of the graph id so the project
 * and the variant — the two parts that disambiguate — always survive, and a
 * short hash of the full ref is appended so two long ids that share a prefix
 * cannot collide.
 */
export function guideSlug(ref: string, variantId = 'default'): string {
  const [project, ...rest] = ref.split('/');
  const id = rest.length ? rest.join('/') : project!;
  const proj = rest.length ? slugPart(project!) : '';
  const variant = slugPart(variantId) || 'default';
  const head = proj ? `${proj}--` : '';
  const tail = `--${variant}`;
  const idSlug = slugPart(id);
  const budget = SLUG_MAX - head.length - tail.length;
  if (idSlug.length <= budget) return `${head}${idSlug}${tail}`;
  const hash = fnv1a(`${ref}#${variantId}`).slice(0, 6);
  const keep = Math.max(1, budget - hash.length - 1);
  return `${head}${idSlug.slice(0, keep)}-${hash}${tail}`;
}

/** What Journey Studio reads out of the annotation (lib/build-core.mjs:76-79). */
export interface GuideMeta {
  objective: string;
  title: string;
  category: string;
  /** The graph ref, verbatim — lets a reader map a guide back to its graph. */
  journeyRef: string;
  /** Persona-matrix variant id (`default` when the graph has no alternatives). */
  variant: string;
  capturable: boolean;
}

export interface GuideAnnotation {
  type: 'guide';
  description: string;
}

/** The Playwright annotation graphs.spec.ts pushes for every test it declares. */
export function guideAnnotation(
  ref: string,
  variant: { id: string; label: string },
  graph: { id: string; title?: string },
): GuideAnnotation {
  const [project, ...rest] = ref.split('/');
  const trimmed = graph.title?.trim() ?? '';
  const base = trimmed.length > 0 ? trimmed : graph.id; // blank title → id, not ''
  const meta: GuideMeta = {
    objective: guideSlug(ref, variant.id),
    title: variant.id === 'default' ? base : `${base} · as ${variant.label}`,
    category: rest.length ? project! : 'legacy',
    journeyRef: ref,
    variant: variant.id,
    capturable: true,
  };
  return { type: 'guide', description: JSON.stringify(meta) };
}

/** Inverse of guideAnnotation — for the planner and for tests. */
export function parseGuideAnnotation(a: { type: string; description?: string }): GuideMeta | null {
  if (a.type !== 'guide' || !a.description) return null;
  try {
    const m = JSON.parse(a.description) as Partial<GuideMeta>;
    if (typeof m.objective !== 'string' || typeof m.journeyRef !== 'string') return null;
    return {
      objective: m.objective,
      title: m.title ?? m.journeyRef,
      category: m.category ?? 'uncategorized',
      journeyRef: m.journeyRef,
      variant: m.variant ?? 'default',
      capturable: m.capturable ?? true,
    };
  } catch {
    return null;
  }
}

/**
 * `<prefix>/studio.html?batch=…&slug=…` — read verbatim by Journey Studio's
 * web/studio.html. `prefix` is where the studio is mounted on the SAME origin
 * (the planner serves it at `/studio`); '' when it is served at its own root.
 */
export function studioPath(batch: string, slug: string, prefix = ''): string {
  const q = new URLSearchParams({ batch, slug });
  return `${prefix.replace(/\/+$/, '')}/studio.html?${q.toString()}`;
}

/** `<prefix>/dashboard.html?batch=…` — the run-level view. */
export function dashboardPath(batch: string, prefix = ''): string {
  const q = new URLSearchParams({ batch });
  return `${prefix.replace(/\/+$/, '')}/dashboard.html?${q.toString()}`;
}

/** Absolute form of studioPath for a studio served on its own origin. */
export function studioUrl(batch: string, slug: string, base = DEFAULT_STUDIO_URL): string {
  return new URL(studioPath(batch, slug), base).toString();
}

/** Absolute form of dashboardPath. */
export function dashboardUrl(batch: string, base = DEFAULT_STUDIO_URL): string {
  return new URL(dashboardPath(batch), base).toString();
}

/**
 * `run-YYYYMMDD-HHMMSS-<spec>` — Journey Studio's HTTP routes sanitise batch
 * ids to `[A-Za-z0-9._-]`; its CLI takes them verbatim, so we only ever emit
 * that charset.
 */
export function batchId(spec: string, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `run-${stamp}-${slugPart(spec).slice(0, 40) || 'run'}`;
}

/** 32-bit FNV-1a, hex — small, dependency-free, stable across runs. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
