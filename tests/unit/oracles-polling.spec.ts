/**
 * S1 — polling oracles. api.* kinds retry a false answer until timeoutMs
 * (async integrations settle in their own time); a THROW stops immediately;
 * ui.* kinds honor a per-expect timeout override; schema polices the fields;
 * the walker carries them into emitted journey steps.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { evaluateOracles, type OracleSpec } from '../../src/journeys/oracles';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';
import { toJourney } from '../../src/graph/toJourney';

const NO_PAGE = undefined as unknown as Page; // api path never touches the page
const ctx = { args: {} };

const apiSpec = (over: Partial<OracleSpec> = {}): OracleSpec => ({
  id: 'in_siebel', kind: 'api.record_exists', target: 'Customer', ...over,
});

test.describe('api.* polling', () => {
  test('a false answer is retried until it turns true — async replication settles', async () => {
    let calls = 0;
    const oracle = async () => { calls += 1; return calls >= 3; };
    const t0 = Date.now();
    const [r] = await evaluateOracles(NO_PAGE, [apiSpec({ timeoutMs: 5000, pollMs: 100 })], ctx, oracle);
    expect(r!.status).toBe('pass');
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(200); // two waits happened
  });

  test('never-true fails at the deadline, reporting how long and how often it checked', async () => {
    let calls = 0;
    const oracle = async () => { calls += 1; return false; };
    const [r] = await evaluateOracles(NO_PAGE, [apiSpec({ timeoutMs: 400, pollMs: 150 })], ctx, oracle);
    expect(r!.status).toBe('fail');
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(r!.message).toContain("api.record_exists 'Customer' did not hold");
    expect(r!.message).toMatch(/after \d+\.\ds \(\d+ checks, every 150ms\)/);
  });

  test('a THROWN error is a precise failure — polling stops on the first attempt', async () => {
    let calls = 0;
    const oracle = async () => { calls += 1; throw new Error('Siebel API returned 500: table locked'); };
    const [r] = await evaluateOracles(NO_PAGE, [apiSpec({ timeoutMs: 5000, pollMs: 100 })], ctx, oracle);
    expect(r!.status).toBe('fail');
    expect(calls).toBe(1);
    expect(r!.message).toContain('table locked');
  });

  test('defaults still apply when no override is set (single check within 10s budget)', async () => {
    const [r] = await evaluateOracles(NO_PAGE, [apiSpec()], ctx, async () => true);
    expect(r!.status).toBe('pass');
  });
});

test.describe('schema validation of the new fields', () => {
  const graphWith = (x: Record<string, unknown>): ProcessGraph => ({
    schema: 'process-graph/2', id: 'g', systems: { app: { label: 'A', kind: 'web' } }, actors: { a: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess', type: 'session', label: 's', system: 'app', actor: 'a' },
      { id: 'd', type: 'data', label: 'd', expects: [{ id: 'x', kind: 'api.record_exists', target: 'Lead', ...x } as never] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess', type: 'login_as' },
      { id: 'e2', from: 'sess', to: 'd', type: 'does', data: { catalog: 'x.y' } },
      { id: 'e3', from: 'sess', to: 'end', type: 'next' },
    ],
  });

  test('good values pass; bad values are named', () => {
    expect(validateGraph(graphWith({ timeoutMs: 120_000, pollMs: 2000, draft: true })).ok).toBe(true);
    expect(validateGraph(graphWith({ timeoutMs: 50 })).errors.join()).toContain('timeoutMs: integer 100..600000');
    expect(validateGraph(graphWith({ timeoutMs: 999_999 })).errors.join()).toContain('timeoutMs');
    expect(validateGraph(graphWith({ pollMs: 10 })).errors.join()).toContain('pollMs: integer ≥ 100');
    expect(validateGraph(graphWith({ timeoutMs: 1000, pollMs: 1000 })).errors.join()).toContain('must be < timeoutMs');
    expect(validateGraph(graphWith({ draft: 'yes' })).errors.join()).toContain('draft: boolean');
  });

  test('pollMs is refused on ui.* oracles — only api kinds poll', () => {
    const g = graphWith({});
    const x = g.nodes[2]!.expects![0] as unknown as Record<string, unknown>;
    x.kind = 'ui.text';
    x.value = 'Saved';
    x.pollMs = 500;
    expect(validateGraph(g).errors.join()).toContain('only backend oracles (api./db./log.) poll');
  });
});

test('toJourney carries timeoutMs/pollMs into the emitted step oracles', () => {
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'g', systems: { app: { label: 'A', kind: 'web' } }, actors: { a: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess', type: 'session', label: 's', system: 'app', actor: 'a' },
      {
        id: 'd', type: 'data', label: 'd',
        expects: [{ id: 'x', kind: 'api.record_exists', target: 'Customer', timeoutMs: 90_000, pollMs: 3000 }],
      },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'e1', from: 'start', to: 'sess', type: 'login_as' },
      { id: 'e2', from: 'sess', to: 'd', type: 'does', data: { catalog: 'x.y' } },
      { id: 'e3', from: 'sess', to: 'end', type: 'next' },
    ],
  };
  const r = toJourney(g, { personaIds: ['admin'] });
  const step = r.journey.steps.find((s) => (s as { do?: string }).do === 'x.y') as { expect?: { expects: OracleSpec[] } };
  expect(step.expect!.expects[0]).toMatchObject({ id: 'x', timeoutMs: 90_000, pollMs: 3000 });
});
