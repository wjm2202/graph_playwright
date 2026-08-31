/**
 * #1C — a login_as edge DECLARES how a session is acquired; personas.json
 * DECIDES. Cast obeys the persona, so a disagreement means the graph
 * documents a login that never happens. Validation catches it instead.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { validateGraph, type ProcessGraph } from '../../src/graph/schema';
import { toJourney } from '../../src/graph/toJourney';
import { PersonaRegistry } from '../../src/personas/registry';
import { goodGraphV2 } from '../helpers/sampleGraph';

const ROSTER = { sales_user: 'frontdoor', admin: 'frontdoor', siebel_admin: 'ui' } as const;

/** The sample with one login_as edge's declared mechanism overridden. */
function withEdgeAuth(edgeId: string, auth: 'frontdoor' | 'singleaccess' | 'ui' | undefined): ProcessGraph {
  const g = goodGraphV2();
  const edge = g.edges.find((e) => e.id === edgeId)!;
  if (auth === undefined) delete edge.data?.auth;
  else edge.data = { ...edge.data, auth };
  return g;
}

test.describe('login_as auth agreement', () => {
  test('the shipped sample agrees with the real personas.json roster', () => {
    const registry = PersonaRegistry.load();
    const v = validateGraph(goodGraphV2(), { personaAuth: registry.authMethods() });
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  test('a contradicting edge is an error that names both sides and the tiebreak', () => {
    // e6 lands on the Siebel session (persona siebel_admin, auth 'ui').
    const v = validateGraph(withEdgeAuth('e6', 'frontdoor'), { personaAuth: ROSTER });
    expect(v.ok).toBe(false);
    const err = v.errors.find((e) => e.includes('e6'))!;
    expect(err).toContain("declares 'frontdoor'");
    expect(err).toContain("persona 'siebel_admin'");
    expect(err).toContain("'ui'");
    expect(err).toContain('personas.json decides');
  });

  test('singleaccess vs frontdoor is caught too (portal personas are the real trap)', () => {
    const v = validateGraph(withEdgeAuth('e1', 'singleaccess'), { personaAuth: ROSTER });
    expect(v.ok).toBe(false);
    expect(v.errors.some((e) => e.includes('e1') && e.includes('singleaccess'))).toBe(true);
  });

  test('an edge with no declared auth is legal — the field stays optional', () => {
    const v = validateGraph(withEdgeAuth('e6', undefined), { personaAuth: ROSTER });
    expect(v.errors.filter((e) => e.includes('data.auth'))).toEqual([]);
  });

  test('without a roster the check is skipped, not silently passed', () => {
    // Callers that cannot read personas.json (file:// planner) still validate
    // everything else; they just cannot judge this one.
    const contradicting = withEdgeAuth('e6', 'frontdoor');
    expect(validateGraph(contradicting).errors.filter((e) => e.includes('data.auth'))).toEqual([]);
    expect(validateGraph(contradicting, { personaAuth: {} }).errors.filter((e) => e.includes('data.auth'))).toEqual([]);
  });

  test('a persona with no auth set cannot contradict anything', () => {
    const v = validateGraph(withEdgeAuth('e6', 'frontdoor'), {
      personaAuth: { ...ROSTER, siebel_admin: undefined },
    });
    expect(v.errors.filter((e) => e.includes('data.auth'))).toEqual([]);
  });

  test('the walker refuses a contradicting graph rather than running it', () => {
    expect(() => toJourney(withEdgeAuth('e6', 'frontdoor'), { personaAuth: ROSTER })).toThrow(
      /data\.auth/,
    );
  });

  test('walking without a roster still works (back-compatible)', () => {
    expect(() => toJourney(goodGraphV2())).not.toThrow();
  });
});

test('AuthMethod is declared twice (graph must transpile standalone) — keep them in step', () => {
  // graph/schema.ts cannot import personas/schema.ts: the planner build
  // transpiles it alone. A test is the only thing holding the two in sync.
  const read = (p: string) => fs.readFileSync(path.resolve(p), 'utf8');
  const literal = (src: string) =>
    /export type AuthMethod =([^;]+);/
      .exec(src)![1]!
      .split('|')
      .map((s) => s.trim().replace(/'/g, ''))
      .sort();

  expect(literal(read('src/graph/schema.ts'))).toEqual(literal(read('src/personas/schema.ts')));
});

test.describe('the regression this check found', () => {
  test('the Siebel session is played by a Siebel persona, not a Salesforce one', () => {
    // The seed graph originally reused the Salesforce 'approver' (persona
    // admin: frontdoor, no site) for a Siebel session — it would have logged
    // into Salesforce and called it Siebel.
    const seed = JSON.parse(
      fs.readFileSync(path.resolve('journeys/graphs/expense_to_siebel.graph.json'), 'utf8'),
    ) as ProcessGraph;
    const siebelSession = seed.nodes.find((n) => n.id === 'sess_siebel_admin')!;
    const alias = siebelSession.actor;
    expect(alias, 'the Siebel session lost its actor').toBeTruthy();
    const persona = seed.actors[alias!]!;
    const registry = PersonaRegistry.load();

    expect(registry.get(persona).site).toBe('siebel');
    expect(registry.authMethods()[persona]).toBe('ui');
  });

  test('every login_as edge in every shipped graph agrees with personas.json', () => {
    const registry = PersonaRegistry.load();
    const personaAuth = registry.authMethods();
    const dir = path.resolve('journeys/graphs');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.graph.json'));
    expect(files.length).toBeGreaterThan(0);

    for (const f of files) {
      const graph = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as ProcessGraph;
      const authErrors = validateGraph(graph, { personaAuth }).errors.filter((e) =>
        e.includes('data.auth'),
      );
      expect(authErrors, `${f} has login_as/persona auth disagreements`).toEqual([]);
    }
  });
});
