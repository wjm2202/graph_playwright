/**
 * #2 — the graph is the source of truth for concurrency. toJourney derived
 * session policies and even WARNED that Cast would logout-to-comply, but
 * nothing handed them to the Cast the generated spec uses. This proves the
 * hand-off happens, before the first step.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { runGraph } from '../../src/graph/run';
import { toJourney } from '../../src/graph/toJourney';
import { StepCatalog } from '../../src/journeys/catalog';
import type { CastLike } from '../../src/journeys/runner';
import type { SessionPolicies } from '../../src/fixtures/cast';
import { goodGraphV2 } from '../helpers/sampleGraph';

/** Records what it was told, and in what order relative to the first login. */
function recordingCast() {
  const applied: SessionPolicies[] = [];
  const events: string[] = [];
  const cast: CastLike = {
    as: (personaId: string) => {
      events.push(`as:${personaId}`);
      return Promise.resolve({} as Page);
    },
    deny: () => Promise.resolve(),
    applySessionPolicies: (p: SessionPolicies) => {
      applied.push(p);
      events.push('policies');
    },
  };
  return { cast, applied, events };
}

test.describe('runGraph → Cast session policies', () => {
  test('policies derived from the graph reach the cast', async () => {
    const { cast, applied } = recordingCast();
    const graph = goodGraphV2();

    await runGraph(graph, { cast, catalog: new StepCatalog() });

    expect(applied).toHaveLength(1);
    // Siebel declares maxConcurrent 1 in the sample's systems block.
    const siebel = applied[0]!.groups.find((g) => g.system === 'siebel');
    expect(siebel?.maxConcurrent).toBe(1);
    expect(siebel?.personas).toContain('siebel_admin');
  });

  test('they match exactly what the walker derived (no second source of truth)', async () => {
    const { cast, applied } = recordingCast();
    const graph = goodGraphV2();

    await runGraph(graph, { cast, catalog: new StepCatalog() });

    expect(applied[0]).toEqual(toJourney(graph).sessionPolicies);
  });

  test('applied BEFORE the first login, or a session escapes the limit', async () => {
    const { cast, events } = recordingCast();
    // A catalog that actually resolves, so logins really happen — with an
    // empty one the run aborts before cast.as() and proves nothing.
    const catalog = new StepCatalog()
      .register('expense.submit', () => Promise.resolve())
      .register('expense.approve', () => Promise.resolve())
      .register('siebel.verify_expense', () => Promise.resolve());
    catalog.registerDeny('expense.approve', () => ({ api: () => Promise.resolve({ denied: true }) }));

    await runGraph(goodGraphV2(), { cast, catalog });

    const firstLogin = events.findIndex((e) => e.startsWith('as:'));
    expect(firstLogin, 'no login happened — the ordering claim is untested').toBeGreaterThan(-1);
    expect(events.indexOf('policies')).toBeLessThan(firstLogin);
  });

  test('a cast without the optional method still runs (harness fakes unchanged)', async () => {
    const minimal: CastLike = {
      as: () => Promise.resolve({} as Page),
      deny: () => Promise.resolve(),
    };
    await expect(
      runGraph(goodGraphV2(), { cast: minimal, catalog: new StepCatalog() }),
    ).resolves.toBeTruthy();
  });
});
