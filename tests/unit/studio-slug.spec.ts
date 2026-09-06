import { test, expect } from '@playwright/test';
import {
  SLUG_MAX,
  batchId,
  dashboardPath,
  dashboardUrl,
  studioPath,
  guideAnnotation,
  guideSlug,
  parseGuideAnnotation,
  slugPart,
  studioUrl,
} from '../../src/studio/slug';

/**
 * The Journey Studio link contract (docs/SCOPE-JOURNEY-STUDIO-INTEGRATION.md §4).
 * Journey Studio uses the annotation's `objective` verbatim as a directory
 * name and a URL param, throws on duplicates, and truncates DERIVED slugs to
 * 60 — so ours must be url-safe, unique per (ref, variant) and ≤ 60 by
 * construction.
 */
const SAFE = /^[a-z0-9_-]+$/;

test.describe('guideSlug', () => {
  test('project ref + default variant', () => {
    expect(guideSlug('salesforce/o2a_tc01_prospect_to_customer', 'default')).toBe(
      'salesforce--o2a_tc01_prospect_to_customer--default',
    );
  });

  test('legacy ref (no project) keeps two parts', () => {
    expect(guideSlug('lead_to_customer')).toBe('lead_to_customer--default');
  });

  test('variant is always in the slug, so the persona matrix cannot collide', () => {
    const a = guideSlug('crm/create_customer', 'default');
    const b = guideSlug('crm/create_customer', 'partner');
    const c = guideSlug('crm/create_customer', 'partner__auditor');
    expect(new Set([a, b, c]).size).toBe(3);
    expect(b).toBe('crm--create_customer--partner');
    expect(c).toBe('crm--create_customer--partner__auditor');
  });

  test('url-safe charset whatever the input', () => {
    for (const ref of ['Sales Force/O2A TC-01 (v2)', 'proj/ümlaut·dots', 'a/b/c', '///', 'x/  ']) {
      for (const v of ['default', 'Partner → Auditor', '']) {
        expect(guideSlug(ref, v)).toMatch(SAFE);
      }
    }
  });

  test('never longer than Journey Studio\'s limit, and still unique when cut', () => {
    const long1 = 'salesforce/' + 'opportunity_to_activation_with_partner_review_'.repeat(3) + 'a';
    const long2 = 'salesforce/' + 'opportunity_to_activation_with_partner_review_'.repeat(3) + 'b';
    const s1 = guideSlug(long1, 'default');
    const s2 = guideSlug(long2, 'default');
    expect(s1.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s2.length).toBeLessThanOrEqual(SLUG_MAX);
    expect(s1).not.toBe(s2);
    // the disambiguating parts survive the cut
    expect(s1.startsWith('salesforce--')).toBe(true);
    expect(s1.endsWith('--default')).toBe(true);
    expect(guideSlug(long1, 'partner').endsWith('--partner')).toBe(true);
  });

  test('deterministic', () => {
    expect(guideSlug('p/x', 'v')).toBe(guideSlug('p/x', 'v'));
  });
});

test.describe('slugPart', () => {
  test('lowercases, collapses runs, trims edges, keeps underscores', () => {
    expect(slugPart('  Hello, World__2 ')).toBe('hello-world__2');
    expect(slugPart('---')).toBe('');
  });
});

test.describe('guideAnnotation ⇄ parseGuideAnnotation', () => {
  const graph = { id: 'o2a_tc01_prospect_to_customer', title: 'Prospect to customer' };

  test('shape Journey Studio reads: type guide, JSON description with objective', () => {
    const a = guideAnnotation('salesforce/o2a_tc01_prospect_to_customer', { id: 'default', label: 'default' }, graph);
    expect(a.type).toBe('guide');
    const meta = JSON.parse(a.description);
    expect(meta).toEqual({
      objective: 'salesforce--o2a_tc01_prospect_to_customer--default',
      title: 'Prospect to customer',
      category: 'salesforce',
      journeyRef: 'salesforce/o2a_tc01_prospect_to_customer',
      variant: 'default',
      capturable: true,
    });
  });

  test('variant label lands in the title the same way graphs.spec.ts titles the test', () => {
    const a = guideAnnotation('salesforce/x', { id: 'partner', label: 'sales → partner' }, { id: 'x' });
    expect(JSON.parse(a.description).title).toBe('x · as sales → partner');
  });

  test('legacy refs are categorised as legacy; untitled graphs fall back to the id', () => {
    const a = guideAnnotation('lead_to_customer', { id: 'default', label: 'default' }, { id: 'lead_to_customer' });
    const meta = JSON.parse(a.description);
    expect(meta.category).toBe('legacy');
    expect(meta.title).toBe('lead_to_customer');
  });

  test('round-trips', () => {
    const a = guideAnnotation('salesforce/x', { id: 'partner', label: 'partner' }, graph);
    const meta = parseGuideAnnotation(a);
    expect(meta?.objective).toBe(guideSlug('salesforce/x', 'partner'));
    expect(meta?.journeyRef).toBe('salesforce/x');
    expect(meta?.variant).toBe('partner');
  });

  test('rejects foreign annotations and malformed JSON without throwing', () => {
    expect(parseGuideAnnotation({ type: 'skip', description: 'x' })).toBeNull();
    expect(parseGuideAnnotation({ type: 'guide', description: '{not json' })).toBeNull();
    expect(parseGuideAnnotation({ type: 'guide', description: '{"title":"no objective"}' })).toBeNull();
    expect(parseGuideAnnotation({ type: 'guide' })).toBeNull();
  });
});

test.describe('paths (same-origin mount)', () => {
  test('studioPath under the planner\'s /studio mount, and at a bare root', () => {
    expect(studioPath('run-1', 'salesforce--x--default', '/studio')).toBe('/studio/studio.html?batch=run-1&slug=salesforce--x--default');
    expect(studioPath('run-1', 's', '/studio/')).toBe('/studio/studio.html?batch=run-1&slug=s');
    expect(studioPath('run-1', 's')).toBe('/studio.html?batch=run-1&slug=s');
    expect(dashboardPath('run-1', '/studio')).toBe('/studio/dashboard.html?batch=run-1');
  });
  test('query values are encoded', () => {
    expect(studioPath('a b', 'c&d', '/studio')).toBe('/studio/studio.html?batch=a+b&slug=c%26d');
  });
});

test.describe('urls', () => {
  test('studio deep link matches web/studio.html\'s query params', () => {
    expect(studioUrl('run-20260906-143012-graph', 'salesforce--x--default')).toBe(
      'http://127.0.0.1:8777/studio.html?batch=run-20260906-143012-graph&slug=salesforce--x--default',
    );
  });

  test('base is overridable and the path is absolute on it', () => {
    expect(studioUrl('b', 's', 'http://localhost:9000/')).toBe('http://localhost:9000/studio.html?batch=b&slug=s');
    expect(dashboardUrl('b', 'http://localhost:9000')).toBe('http://localhost:9000/dashboard.html?batch=b');
  });
});

test.describe('batchId', () => {
  test('run-YYYYMMDD-HHMMSS-<spec>, charset Journey Studio accepts unchanged', () => {
    const id = batchId('graph:salesforce/o2a_tc01', new Date(2026, 8, 6, 14, 30, 12));
    expect(id).toBe('run-20260906-143012-graph-salesforce-o2a_tc01');
    expect(id).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  test('spec part is capped; empty spec still yields an id', () => {
    const id = batchId('x'.repeat(100), new Date(2026, 0, 1));
    expect(id.length).toBeLessThanOrEqual('run-20260101-000000-'.length + 40);
    expect(batchId('///', new Date(2026, 0, 1))).toBe('run-20260101-000000-run');
  });
});
