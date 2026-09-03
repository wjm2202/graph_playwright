/**
 * S6 — the grillme engine: gap detection on drafts, and answer write-back
 * that shrinks the gap list monotonically toward zero.
 *
 * Sprint 4.4 (review §3.1): twelve kinds → eight, eleven ops → eight.
 * `computeGaps` returns `{ gaps, hints }` — a gap has an op behind it, a
 * hint has none and never blocks.
 */
import { test, expect } from '@playwright/test';
import { computeGaps, applyAnswers, ANSWER_OPS, GAP_KINDS, HINT_KINDS } from '../../src/graph/gaps';
import { adoCaseToGraph, parseAdoPaste } from '../../src/graph/fromAdo';
import { validateGraph } from '../../src/graph/schema';
import { goodGraphV2 } from '../helpers/sampleGraph';

const KNOWN = ['lead_creator', 'lead_approver', 'siebel_admin', 'sales_user', 'admin'];

const draft = () =>
  adoCaseToGraph(
    parseAdoPaste([
      'Title: Lead flow',
      '1. As a lead creator, create a lead | Lead record is created',
      '2. As a lead approver, approve the lead | Toast shows "Approved"',
    ].join('\n')),
    { knownPersonas: KNOWN },
  ).graph;

test('the engine names exactly eight gap kinds, three hints and eight ops', () => {
  expect(GAP_KINDS).toHaveLength(8);
  expect(HINT_KINDS).toHaveLength(3);
  expect(ANSWER_OPS).toHaveLength(8);
  // The retired vocabulary must not come back by accident.
  for (const gone of ['session_no_url', 'no_oracles', 'no_deny_coverage', 'data_io_draft', 'data_no_port']) {
    expect(GAP_KINDS as string[]).not.toContain(gone);
  }
  for (const gone of ['confirmExpect', 'removeExpect', 'confirmIo', 'setOrigin', 'setUrl']) {
    expect(ANSWER_OPS as readonly string[]).not.toContain(gone);
  }
});

test('an ADO draft is fully interrogated: captures, drafts, ports; urls and deny are hints', () => {
  const { gaps, hints } = computeGaps(draft(), { knownPersonas: KNOWN });
  const kinds = gaps.map((g) => g.kind);
  expect(kinds).toContain('not_captured');     // nothing recorded yet
  expect(kinds).toContain('draft_oracle');     // the two guessed checks
  expect(kinds).not.toContain('role_unbound'); // both roles known
  expect(kinds).not.toContain('does_unbound'); // convention named everything
  // A single-system graph's api.* check on the 10s default is NOT a question.
  expect(kinds).not.toContain('api_no_timeout');
  const hintKinds = hints.map((h) => h.kind);
  expect(hintKinds).toContain('session_no_url');   // pre-navigation unknown
  expect(hintKinds).toContain('no_deny_coverage'); // two roles, no negative test
  for (const g of [...gaps, ...hints]) expect(g.question.length).toBeGreaterThan(10); // askable as-is
});

test('api_no_timeout fires on a log/db check, and on api.* once the graph spans two systems', () => {
  const g = goodGraphV2(); // sf + siebel
  expect(Object.keys(g.systems).length).toBeGreaterThan(1);
  expect(computeGaps(g, { knownPersonas: KNOWN }).gaps.map((x) => x.kind)).toContain('api_no_timeout');

  // Collapse it to one system: the same check stops being a question.
  const single = goodGraphV2();
  const only = Object.keys(single.systems)[0]!;
  single.systems = { [only]: single.systems[only]! };
  for (const n of single.nodes) if (n.type === 'session') n.system = only;
  expect(computeGaps(single, { knownPersonas: KNOWN }).gaps.map((x) => x.kind)).not.toContain('api_no_timeout');
});

test('every gap and hint carries a short imperative for grouped display (S20)', () => {
  const both = (g: ReturnType<typeof draft>, known: string[]) => {
    const r = computeGaps(g, { knownPersonas: known });
    return [...r.gaps, ...r.hints];
  };
  const all = [
    ...both(draft(), ['sales_user']),   // + role_unbound
    ...both(goodGraphV2(), KNOWN),      // + session/policy angles
  ];
  expect(all.length).toBeGreaterThan(5);
  for (const g of all) {
    expect(g.short, `${g.kind}@${g.at} needs a short`).toBeTruthy();
    expect(g.short.length).toBeGreaterThan(10);  // a real imperative, not a stub
    expect(g.short.length).toBeLessThan(110);    // one scannable line in the panel
    expect(g.short).not.toMatch(/^(Role|Session|System|Step) '/); // element named by the group header, not repeated
  }
});

test('unknown personas surface as role_unbound with the roster as options', () => {
  const { gaps } = computeGaps(draft(), { knownPersonas: ['sales_user'] });
  const role = gaps.find((g) => g.kind === 'role_unbound')!;
  expect(role).toBeDefined();
  expect(role.options).toEqual(['sales_user']);
});

test('a session policy already settled elsewhere in the project is not asked again', () => {
  const g = goodGraphV2();
  const siebel = Object.entries(g.systems).find(([, s]) => s.kind === 'siebel');
  expect(siebel, 'the sample graph must carry a non-SF system').toBeTruthy();
  delete g.systems[siebel![0]]!.sessionPolicy;
  expect(computeGaps(g, { knownPersonas: KNOWN }).gaps.map((x) => x.kind)).toContain('no_session_policy');
  const settled = computeGaps(g, { knownPersonas: KNOWN, settledSystems: [siebel![0]] });
  expect(settled.gaps.map((x) => x.kind)).not.toContain('no_session_policy');
});

test('answers shrink the gap list, and the applied graph stays valid', () => {
  const g = goodGraphV2();
  const before = computeGaps(g, { knownPersonas: KNOWN }).gaps;

  const holder = g.nodes.find((n) => (n.expects ?? []).some((x) => x.kind.startsWith('api.')))!;
  const apiCheck = holder.expects!.find((x) => x.kind.startsWith('api.'))!;
  const denyFrom = g.nodes.find((n) => n.type === 'session')!.id;
  const { graph: after, changes } = applyAnswers(g, [
    { op: 'answerExpect', node: holder.id, id: apiCheck.id, keep: true },
    { op: 'setOracleBudget', node: holder.id, id: apiCheck.id, timeoutMs: 120_000, pollMs: 5000 },
    { op: 'addDeny', from: denyFrom, to: holder.id, capability: 'expense.delete' },
  ]);
  expect(changes).toHaveLength(3);
  expect(validateGraph(after).errors).toEqual([]);

  const remaining = computeGaps(after, { knownPersonas: KNOWN }).gaps;
  expect(remaining.length).toBeLessThan(before.length);
  // The budgeted check stops asking; other unbudgeted ones may still.
  expect(remaining.some((x) => x.kind === 'api_no_timeout' && x.at === `${holder.id}.${apiCheck.id}`)).toBe(false);
  // The source graph was untouched (pure):
  expect(g.nodes.find((n) => n.id === holder.id)!.expects!.find((x) => x.id === apiCheck.id)!.timeoutMs)
    .toBe(apiCheck.timeoutMs);
});

test('answerExpect removes when keep is false', () => {
  const g = draft();
  const lead = g.nodes.find((n) => n.id === 'lead')!;
  const victim = lead.expects![0]!.id;
  const { graph: after, changes } = applyAnswers(g, [{ op: 'answerExpect', node: 'lead', id: victim, keep: false }]);
  expect(changes[0]).toContain('removed');
  expect((after.nodes.find((n) => n.id === 'lead')!.expects ?? []).some((x) => x.id === victim)).toBe(false);
});

test('a completed, captured graph asks almost nothing', () => {
  const g = goodGraphV2();
  for (const n of g.nodes) {
    if (n.type === 'session') {
      n.steps = { status: 'captured', journeyId: 'expense_v2' };
      n.url = '/lightning/page';
    }
  }
  const kinds = computeGaps(g, { knownPersonas: KNOWN }).gaps.map((x) => x.kind);
  expect(kinds).not.toContain('not_captured');
  expect(kinds).not.toContain('no_session_policy'); // siebel policy declared
  expect(kinds).not.toContain('draft_oracle');
  // Only the api timeout question remains — expense checks ride the default
  // and this graph spans two systems, so the budget IS a real question:
  expect([...new Set(kinds)]).toEqual(['api_no_timeout']);
});

test('bad ops fail loudly and never write', () => {
  const g = draft();
  expect(() => applyAnswers(g, [{ op: 'setCatalog', edge: 'ghost', name: 'x.y' }])).toThrow(/unknown edge/);
  expect(() => applyAnswers(g, [{ op: 'answerExpect', node: 'lead', id: 'ghost', keep: true }])).toThrow(/unknown expectation/);
  expect(() => applyAnswers(g, [{ op: 'answerExpect', node: 'lead', id: 'ghost', keep: false }])).toThrow(/unknown expectation/);
  expect(() => applyAnswers(g, [{ op: 'bindRole', alias: 'ghost', personaId: 'admin' }])).toThrow(/unknown role/);
});
