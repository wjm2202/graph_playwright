/**
 * PG-INFER — the guesses the planner makes instead of asking (REVIEW-
 * SIMPLIFICATION-2026-09-03.md §5.1). Pins the four inferences against the
 * PROTOTYPE's `analyse()`/`catalogOf` contract, and the verb table against
 * fromAdo's `verbIo` (one classification, copied for standalone transpile —
 * this test is the thing that keeps the copy honest).
 */
import { test, expect } from '@playwright/test';
import {
  applyInferredPorts, catalogFor, inferPorts, labelPort, relationFor,
  sessionLabel, CREATE_VERBS, RELATION_RULES, UPDATE_VERBS,
} from '../../src/graph/infer';
import { verbIo } from '../../src/graph/fromAdo';
import { dataflowHealth } from '../../src/graph/compose';
import { computeGaps } from '../../src/graph/gaps';
import { validateGraph, type EdgeType, type NodeType, type PEdge, type ProcessGraph } from '../../src/graph/schema';

const SF = { label: 'Salesforce', kind: 'salesforce' as const };

/** One session, one record; the caller decides the step edges. */
function graphWith(edges: PEdge[], opts: { origin?: 'seed' | 'external'; sessions?: number } = {}): ProcessGraph {
  const sessions = opts.sessions ?? 1;
  const g: ProcessGraph = {
    schema: 'process-graph/2', id: 'g', systems: { sf: { ...SF } },
    actors: { a: 'admin' },
    nodes: [
      { id: 'start', type: 'start', label: '' },
      { id: 'customer', type: 'data', label: 'Customer record', sobject: 'Account', ...(opts.origin ? { origin: opts.origin } : {}) },
      { id: 'end', type: 'end', label: '' },
    ],
    edges: [{ id: 'e_end', from: 'customer', to: 'end', type: 'next' }],
  };
  let prev = 'start';
  for (let i = 1; i <= sessions; i++) {
    const id = `sess_${i}`;
    g.nodes.push({ id, type: 'session', label: `SF · a${i}`, system: 'sf', actor: 'a' });
    g.edges.push({ id: `l${i}`, from: prev, to: id, type: 'login_as' });
    prev = id;
  }
  g.edges.push(...edges);
  return g;
}

const step = (id: string, from: string, label: string, data?: PEdge['data']): PEdge => ({
  id, from, to: 'customer', type: 'does', label,
  data: { catalog: `cust.${id}`, ...data },
});

// ---------- 1. relationFor ----------

test.describe('relationFor', () => {
  test('every pair a drag can make resolves the way the table says', () => {
    const cases: [NodeType, NodeType, EdgeType | null][] = [
      ['start', 'session', 'login_as'],
      ['session', 'session', 'login_as'],
      ['session', 'data', 'does'],
      ['session', 'screen', 'does'],
      ['session', 'checkpoint', 'does'],
      ['session', 'db', 'touches'],
      ['session', 'logger', 'touches'],
      ['session', 'api', 'touches'],
      ['data', 'api', 'handoff'],
      ['api', 'data', 'handoff'],
      ['data', 'data', 'handoff'],
      ['session', 'end', 'next'],
      ['data', 'end', 'next'],
      ['checkpoint', 'end', 'next'],
      // No rule — the planner still has to ask.
      ['data', 'session', null],
      ['start', 'data', null],
      ['screen', 'checkpoint', null],
      ['db', 'logger', null],
    ];
    for (const [from, to, want] of cases) {
      expect(relationFor(from, to), `${from} → ${to}`).toBe(want);
    }
  });

  test('the table is exported with a reason per rule (the UI explains the drag)', () => {
    expect(RELATION_RULES.length).toBeGreaterThan(0);
    for (const rule of RELATION_RULES) {
      expect(rule.from.length).toBeGreaterThan(0);
      expect(rule.to.length).toBeGreaterThan(0);
      expect(rule.why.length).toBeGreaterThan(4);
    }
    // Whatever the table says IS what the function answers.
    for (const rule of RELATION_RULES) {
      for (const from of rule.from) {
        for (const to of rule.to) {
          expect(relationFor(from, to)).not.toBeNull();
        }
      }
    }
  });
});

// ---------- 2. catalogFor ----------

test.describe('catalogFor', () => {
  const g = graphWith([]);

  test("the prototype's case: 'create Customer record' → customer.create", () => {
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'customer', type: 'does', label: 'create Customer record' }, g))
      .toBe('customer.create');
  });

  test('a multi-word label keeps only its first word as the verb', () => {
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'customer', type: 'does', label: 'Approve the customer for billing' }, g))
      .toBe('customer.approve');
  });

  test('a one-word label IS the verb', () => {
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'customer', type: 'does', label: 'verify' }, g))
      .toBe('customer.verify');
  });

  test('an existing catalog is returned untouched — this suggests, never renames', () => {
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'customer', type: 'does', label: 'create Customer record', data: { catalog: 'cust.create' } }, g))
      .toBe('cust.create');
  });

  test('no label at all still names something addressable', () => {
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'customer', type: 'does' }, g)).toBe('customer.step');
    // Unknown target: the edge's own endpoint id carries the record name.
    expect(catalogFor({ id: 'e', from: 'sess_1', to: 'lead_record', type: 'does', label: 'convert it' }, g)).toBe('lead.convert');
  });
});

// ---------- 3. sessionLabel ----------

test.describe('sessionLabel', () => {
  test('<system label> · <actor alias> — the label the planner never derived', () => {
    const g = graphWith([]);
    g.systems.siebel = { label: 'Siebel', kind: 'siebel' };
    expect(sessionLabel({ id: 's', type: 'session', label: 'System · role', system: 'sf', actor: 'client_associate' }, g))
      .toBe('Salesforce · client_associate');
    expect(sessionLabel({ id: 's', type: 'session', label: '', system: 'siebel', actor: 'billing' }, g))
      .toBe('Siebel · billing');
  });

  test('unknown system falls back to its key; unchosen halves stay prompts', () => {
    const g = graphWith([]);
    expect(sessionLabel({ id: 's', type: 'session', label: '', system: 'oracle', actor: 'a' }, g)).toBe('oracle · a');
    expect(sessionLabel({ id: 's', type: 'session', label: '' }, g)).toBe('System · role');
  });
});

// ---------- 4. inferPorts ----------

test.describe('inferPorts', () => {
  test('the first does onto a record produces it; a later read consumes it', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer'), step('d2', 'sess_1', 'verify Customer')]);
    const { ports, definedBy } = inferPorts(g);
    expect(ports.get('d1')).toMatchObject({ io: 'produces', draft: true });
    expect(ports.get('d1')?.reason).toContain('first touch');
    expect(ports.get('d2')).toMatchObject({ io: 'consumes', draft: true });
    expect(definedBy.get('customer')).toBe('d1');
  });

  test('a later touch whose verb CHANGES the record updates it', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer'), step('d2', 'sess_1', 'approve Customer')]);
    expect(inferPorts(g).ports.get('d2')).toMatchObject({ io: 'updates' });

    // And "add a new address" is a creation, not an edit — same phrase rule
    // fromAdo uses, so a first touch phrased that way still produces.
    const g2 = graphWith([step('d1', 'sess_1', 'add a new Customer')]);
    expect(inferPorts(g2).ports.get('d1')).toMatchObject({ io: 'produces' });
  });

  test('seed/external records are already defined — the first touch reads them', () => {
    for (const origin of ['seed', 'external'] as const) {
      const g = graphWith([step('d1', 'sess_1', 'verify Customer')], { origin });
      const p = inferPorts(g).ports.get('d1');
      expect(p, origin).toMatchObject({ io: 'consumes', draft: true });
      expect(p?.reason).toContain(origin);
      // Nothing on the walk defines it: the definition is declared, not drawn.
      expect(inferPorts(g).definedBy.has('customer')).toBe(false);
    }
    // A mutating verb on a declared record still updates it — the record
    // exists either way, so only "does it change?" is left to decide.
    const g = graphWith([step('d1', 'sess_1', 'approve Customer')], { origin: 'seed' });
    expect(inferPorts(g).ports.get('d1')).toMatchObject({ io: 'updates' });
  });

  test('an explicit port is respected and is not a draft unless ioDraft says so', () => {
    const g = graphWith([
      step('d1', 'sess_1', 'verify Customer', { io: 'consumes' }),
      step('d2', 'sess_1', 'create Customer', { io: 'produces', ioDraft: true }),
    ]);
    const { ports, definedBy } = inferPorts(g);
    expect(ports.get('d1')).toMatchObject({ io: 'consumes', draft: false });
    expect(ports.get('d2')).toMatchObject({ io: 'produces', draft: true });
    expect(definedBy.get('customer')).toBe('d2');
  });

  test('two sessions sharing a record: producer in session 1, consumer in session 2', () => {
    const g = graphWith(
      [step('d1', 'sess_1', 'create Customer'), step('d2', 'sess_2', 'verify Customer')],
      { sessions: 2 },
    );
    const { ports, definedBy } = inferPorts(g);
    expect(ports.get('d1')).toMatchObject({ io: 'produces' });
    expect(ports.get('d2')).toMatchObject({ io: 'consumes' });
    expect(definedBy.get('customer')).toBe('d1');
    // The inference is what makes goal 2 hold: after applying it, the flow
    // is clean end to end.
    expect(dataflowHealth(applyInferredPorts(g)).errors).toEqual([]);
  });

  test('consumed before produced: the port stands, dataflowHealth argues', () => {
    const g = graphWith(
      [step('d1', 'sess_1', 'verify Customer', { io: 'consumes' }), step('d2', 'sess_2', 'create Customer')],
      { sessions: 2 },
    );
    const { ports } = inferPorts(g);
    expect(ports.get('d1')).toMatchObject({ io: 'consumes' });
    // d2 is the first thing that DEFINES the record, so it produces it.
    expect(ports.get('d2')).toMatchObject({ io: 'produces' });

    const health = dataflowHealth(applyInferredPorts(g));
    expect(health.errors).toHaveLength(1);
    expect(health.errors[0]).toContain('nothing defines it before this point');
  });

  test('only does edges on the walked chain are inferred', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer')]);
    g.nodes.push({ id: 'sess_lost', type: 'session', label: 'SF · stranded', system: 'sf', actor: 'a' });
    g.edges.push(step('d_lost', 'sess_lost', 'verify Customer'));
    const { ports } = inferPorts(g);
    expect(ports.has('d1')).toBe(true);
    expect(ports.has('d_lost')).toBe(false); // chainHealth lists it until it is wired in
  });
});

// ---------- applyInferredPorts ----------

test.describe('applyInferredPorts', () => {
  test('returns a copy: the input graph is byte-identical afterwards', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer'), step('d2', 'sess_1', 'verify Customer')]);
    const before = JSON.stringify(g);
    const painted = applyInferredPorts(g);
    expect(JSON.stringify(g)).toBe(before);
    expect(painted).not.toBe(g);
    expect(validateGraph(painted).errors).toEqual([]);
    expect(painted.edges.find((e) => e.id === 'd1')?.data).toMatchObject({ io: 'produces', ioDraft: true });
    expect(painted.edges.find((e) => e.id === 'd2')?.data).toMatchObject({ io: 'consumes', ioDraft: true });
  });

  test('data_no_port becomes data_io_draft — an open question becomes one with a default', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer'), step('d2', 'sess_1', 'approve Customer')]);
    const kinds = (doc: ProcessGraph) => computeGaps(doc).filter((x) => x.kind === 'data_no_port' || x.kind === 'data_io_draft');

    expect(kinds(g).map((x) => x.kind)).toEqual(['data_no_port', 'data_no_port']);
    const after = kinds(applyInferredPorts(g));
    expect(after.map((x) => x.kind)).toEqual(['data_io_draft', 'data_io_draft']);
    expect(after[0]?.question).toContain('produces');
    expect(after[1]?.question).toContain('updates');
    expect(after[0]?.options?.[0]).toBe('keep: produces');
  });

  test('an authored port is never overwritten', () => {
    const g = graphWith([step('d1', 'sess_1', 'create Customer', { io: 'updates' })]);
    const painted = applyInferredPorts(g);
    expect(painted.edges.find((e) => e.id === 'd1')?.data).toMatchObject({ io: 'updates' });
    expect(painted.edges.find((e) => e.id === 'd1')?.data?.ioDraft).toBeUndefined();
  });
});

// ---------- the copied verb table ----------

test.describe('verb table agreement with fromAdo', () => {
  const PHRASES = [
    'create Customer', 'convert the Lead', 'submit expense', 'register the account',
    'raise a case', 'log the call', 'new Opportunity',
    'update Customer', 'edit the address', 'approve the expense', 'progress the case',
    'add the address', 'delete the contact', 'remove the line', 'change the owner',
    'set the status', 'assign the queue', 'close the case', 'reject the expense', 'cancel the order',
    'verify Customer', 'open the record', 'check the toast', 'search for the lead',
    'add a new address', 'enter a new contact', 'log a new call',
    'Approve The Expense', 'CREATE customer',
  ];

  test('infer.labelPort classifies exactly as fromAdo.verbIo does', () => {
    for (const phrase of PHRASES) {
      expect(labelPort(phrase), phrase).toBe(verbIo(phrase));
    }
  });

  test('the exported verb lists are the same tables, and they do not overlap', () => {
    for (const verb of CREATE_VERBS) expect(labelPort(verb), verb).toBe('produces');
    for (const verb of UPDATE_VERBS) expect(labelPort(verb), verb).toBe('updates');
    expect(CREATE_VERBS.filter((v) => UPDATE_VERBS.includes(v))).toEqual([]);
    expect(labelPort('')).toBe('consumes');
    expect(labelPort(undefined)).toBe('consumes');
  });
});
