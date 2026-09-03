/**
 * Chain health + run-order preview — the referee for hand-wired seams.
 * chainHealth catches what validateGraph deliberately tolerates (drafts must
 * stay saveable): branched/cyclic/disconnected chains red, stranded sessions
 * amber. runOrder IS the walk (toJourney consumes it), so what remains to
 * pin is that the exporter really goes through it — checked on the shipped
 * graphs, the only place drift could hide.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { chainHealth, loginChain, runOrder } from '../../src/graph/compose';
import { toJourney } from '../../src/graph/toJourney';
import { isDenyStep } from '../../src/journeys/schema';
import type { ProcessGraph } from '../../src/graph/schema';

const SF = { label: 'SF', kind: 'salesforce' as const };

function twoSessionGraph(): ProcessGraph {
  return {
    schema: 'process-graph/2', id: 'g', systems: { sf: { ...SF } },
    actors: { a: 'admin', b: 'sales_user' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'sess_a', type: 'session', label: 'A', system: 'sf', actor: 'a' },
      { id: 'sess_b', type: 'session', label: 'B', system: 'sf', actor: 'b' },
      { id: 'rec', type: 'data', label: 'Record' },
      { id: 'chk', type: 'checkpoint', label: 'Check', expects: [{ id: 'x', kind: 'ui.text', value: 'ok' }] },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [
      { id: 'l1', from: 'start', to: 'sess_a', type: 'login_as' },
      { id: 'l2', from: 'sess_a', to: 'sess_b', type: 'login_as' },
      { id: 'd1', from: 'sess_a', to: 'rec', type: 'does', label: 'create record', data: { catalog: 'rec.create' } },
      { id: 'd2', from: 'sess_b', to: 'rec', type: 'does', label: 'approve record', data: { catalog: 'rec.approve' } },
      { id: 'x1', from: 'sess_b', to: 'chk', type: 'asserts' },
      { id: 'dn', from: 'sess_b', to: 'rec', type: 'denied', label: 'must NOT', data: { capability: 'rec.delete' } },
      { id: 'n1', from: 'chk', to: 'end', type: 'next' },
    ],
  };
}

test.describe('chainHealth', () => {
  test('a wired chain is clean; a sessionless graph is silent', () => {
    expect(chainHealth(twoSessionGraph())).toEqual({ errors: [], stranded: [] });
    expect(chainHealth({ ...twoSessionGraph(), nodes: [{ id: 'start', type: 'start', label: '' }], edges: [] })).toEqual({ errors: [], stranded: [] });
  });

  test('a branch is a red error naming the node', () => {
    const g = twoSessionGraph();
    g.nodes.push({ id: 'sess_c', type: 'session', label: 'C', system: 'sf', actor: 'a' });
    g.edges.push({ id: 'l3', from: 'sess_a', to: 'sess_c', type: 'login_as' });
    const h = chainHealth(g);
    expect(h.errors.join()).toContain("'sess_a' has 2 outgoing login_as edges");
  });

  test('a cycle is a red error', () => {
    const g = twoSessionGraph();
    g.edges.push({ id: 'l3', from: 'sess_b', to: 'sess_a', type: 'login_as' });
    expect(chainHealth(g).errors.join()).toContain('cycle');
  });

  test('a start wired to nothing strands every session', () => {
    const g = twoSessionGraph();
    g.edges = g.edges.filter((e) => e.id !== 'l1');
    const h = chainHealth(g);
    expect(h.errors.join()).toContain('start is not connected');
    expect(h.stranded).toEqual(['sess_a', 'sess_b']);
  });

  test('an unwired session is stranded, not an error — amber, fix or delete', () => {
    const g = twoSessionGraph();
    g.nodes.push({ id: 'sess_new', type: 'session', label: 'N', system: 'sf', actor: 'a' });
    expect(chainHealth(g)).toEqual({ errors: [], stranded: ['sess_new'] });
  });
});

test.describe('runOrder is the walk', () => {
  const dir = path.resolve('journeys', 'graphs');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.graph.json')).sort()) {
    test(`toJourney exports ${file} in exactly runOrder's session and step order`, () => {
      const g = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as ProcessGraph;
      const order = runOrder(g);
      const walked = toJourney(g);

      expect(order.problem).toBeUndefined();
      // Sessions: the chain the walk visits is every session node, in login order.
      expect(order.chain).toEqual(loginChain(g, file));
      expect([...order.chain].sort()).toEqual(g.nodes.filter((n) => n.type === 'session').map((n) => n.id).sort());
      // Steps: same count, same names, same actors, same source edges.
      expect(order.steps.length).toBe(walked.journey.steps.length);
      walked.journey.steps.forEach((s, i) => {
        const p = order.steps[i]!;
        if (isDenyStep(s)) {
          expect(p.kind).toBe('denied');
          expect(p.name).toBe(s.deny.capability);
          expect(p.actor).toBe(s.deny.actor);
        } else {
          expect(p.name).toBe(s.do);
          expect(p.actor).toBe(s.actor);
        }
        expect(p.edgeId).toBe(walked.stepEdgeIds[i]);
        // …and each step belongs to the session the chain says it does.
        expect(order.chain).toContain(p.sessionId);
      });
    });
  }

  test('an unwalkable chain reports the problem instead of a wrong order', () => {
    const g = twoSessionGraph();
    g.edges.push({ id: 'l3', from: 'sess_a', to: 'sess_b', type: 'login_as' });
    const r = runOrder(g);
    expect(r.steps).toEqual([]);
    expect(r.problem).toContain('outgoing login_as');
  });
});
