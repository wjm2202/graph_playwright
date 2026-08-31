/**
 * S2 — capture-first v2: one recording collapses into the compact plan graph
 * a human would have drawn (sessions → does → data), with DRAFT oracles from
 * observed signals, full micro-step provenance, and a composite steps module
 * that replays each edge's slice of the generated journey.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compactFromDistillation, graphStepsModuleSource, emitCaptureGraph } from '../../src/graph/fromCapture';
import { runJourneySlice } from '../../src/journeys/slice';
import { StepCatalog, type StepCtx } from '../../src/journeys/catalog';
import { validateGraph } from '../../src/graph/schema';
import { readTrace } from '../../src/pipeline/traceReader';
import { distill, type Distillation } from '../../src/pipeline/distill';

const stepAt = (
  catalog: string,
  startMs: number,
  endMs: number,
  args: Record<string, unknown> = {},
  actorAlias?: string,
): Distillation['steps'][0] => ({
  kind: 'step', catalog, args, startMs, endMs, durationMs: endMs - startMs,
  recognized: true, sourceEvents: [], ...(actorAlias ? { actorAlias } : {}),
});

const LEAD_ID = '00Qxx0000012AbCDEF';

/** Two actors: creator fills + saves a Lead and opens it; approver clicks Approve on it. */
const twoActorCapture = (): Distillation => ({
  steps: [
    stepAt('nav.goto', 0, 100, { url: 'https://uat.my.salesforce.com/lightning/o/Lead/list' }, 'creator'),
    stepAt('form.fill', 200, 300, { label: 'Last Name', value: '{fake:person.lastName}' }, 'creator'),
    stepAt('form.fill', 350, 450, { label: 'Company', value: '{fake:company}' }, 'creator'),
    stepAt('modal.save', 500, 1200, { button: 'Save', settle: 'aura' }, 'creator'),
    stepAt('recordPage.open', 1300, 1600, { sobject: 'Lead', id: LEAD_ID }, 'creator'),
    stepAt('recordPage.open', 5000, 5400, { sobject: 'Lead', id: LEAD_ID }, 'approver'),
    stepAt('ui.click', 5500, 6000, { name: 'Submit for Approval' }, 'approver'),
  ],
  harvestedIds: [{ id: LEAD_ID, sobject: 'Lead', firstEvent: 4 }],
  flags: [],
});

const OPTS = {
  graphId: 'lead_capture',
  journeyId: 'lead_capture',
  actors: { creator: 'lead_creator', approver: 'lead_approver' },
  systems: { sf: { label: 'Salesforce', kind: 'salesforce' as const } },
};

test.describe('compactFromDistillation', () => {
  test('collapses a two-actor capture into the graph a human would have drawn', () => {
    const { graph } = compactFromDistillation(twoActorCapture(), OPTS);

    expect(validateGraph(graph).errors).toEqual([]);
    expect(graph.schema).toBe('process-graph/2');

    // Shape: start → sess_creator → sess_approver → end, ONE data node.
    expect(graph.nodes.map((n) => `${n.id}:${n.type}`)).toEqual([
      'start:start', 'sess_creator:session', 'lead:data', 'sess_approver:session', 'end:end',
    ]);
    expect(graph.edges.map((e) => `${e.id}:${e.type}`)).toEqual([
      'e_login_1:login_as', 'e_do_1_1:does',
      'e_login_2:login_as', 'e_do_2_1:does',
      'e_end:next',
    ]);

    // Human-named catalogs, no naming meeting required. The post-save
    // redirect (recordPage.open) folded INTO lead.save and brought the
    // SObject signal with it:
    const does = graph.edges.filter((e) => e.type === 'does');
    expect(does.map((e) => e.data!.catalog)).toEqual(['lead.save', 'lead.submit_for_approval']);

    // Provenance partitions the capture — every micro-step owned by exactly one edge:
    const owned = does.flatMap((e) => (e.data as { stepIndexes: number[] }).stepIndexes);
    expect([...owned].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);

    // Sessions are captured, journey-stamped, and timed from the wall clock:
    const creator = graph.nodes.find((n) => n.id === 'sess_creator')!;
    expect(creator.steps).toMatchObject({ status: 'captured', journeyId: 'lead_capture' });
    expect(creator.timing?.capturedMeanMs).toBe(1600);
    expect(creator.url).toContain('uat.my.salesforce.com');

    // Both actors land on the SAME data node — the shared state node IS the
    // handoff, so no redundant handoff edge is drawn:
    expect(graph.edges.some((e) => e.type === 'handoff')).toBe(false);
  });

  test('an object-less record id crossing actors draws an explicit handoff edge', () => {
    // The SObject was never revealed (no record page, no typed nav) — both
    // groups collapse to screens, so the shared id must be drawn as a handoff.
    const d: Distillation = {
      steps: [
        stepAt('form.fill', 0, 100, { label: 'Subject', value: 'Broken widget' }, 'creator'),
        stepAt('ui.click', 200, 700, { name: 'Submit', itemId: LEAD_ID }, 'creator'),
        stepAt('ui.click', 5000, 5400, { name: 'Open item', itemId: LEAD_ID }, 'approver'),
        stepAt('ui.click', 5500, 6000, { name: 'Confirm', itemId: LEAD_ID }, 'approver'),
      ],
      harvestedIds: [{ id: LEAD_ID, firstEvent: 1 }], // sobject unknown
      flags: [],
    };
    const { graph } = compactFromDistillation(d, OPTS);
    const hand = graph.edges.find((e) => e.type === 'handoff')!;
    expect(hand).toBeDefined();
    expect(hand.data?.recordRef).toBe(LEAD_ID);
    for (const end of [hand.from, hand.to]) {
      expect(graph.nodes.find((n) => n.id === end)?.type).toBe('screen');
    }
    expect(hand.from).not.toBe(hand.to);
  });

  test('drafts oracles from observed signals — flagged, never silently trusted', () => {
    const { graph } = compactFromDistillation(twoActorCapture(), OPTS);
    const lead = graph.nodes.find((n) => n.id === 'lead')!;
    expect(lead.expects).toEqual([
      expect.objectContaining({
        id: 'lead_exists', kind: 'api.record_exists', target: 'Lead',
        draft: true, after: 'e_do_1_1',
      }),
      expect.objectContaining({ id: 'lead_page', kind: 'ui.url', value: '/lightning/r/Lead/', draft: true }),
    ]);
    for (const x of lead.expects!) expect(x.note).toContain('confirm once');
    // No toast guesses — toast text is not in traces:
    expect(lead.expects!.some((x) => x.kind === 'ui.toast')).toBe(false);
  });

  test('unnamed raw steps are flagged, never dropped from provenance', () => {
    const d = twoActorCapture();
    d.steps.splice(3, 0, {
      kind: 'raw', catalog: 'raw.name_me', args: { api: 'mouse.down' },
      startMs: 460, endMs: 470, durationMs: 10, recognized: false, sourceEvents: [],
      actorAlias: 'creator',
    });
    const { graph, flags } = compactFromDistillation(d, OPTS);
    expect(flags.join()).toContain('unnamed raw step');
    const does = graph.edges.filter((e) => e.type === 'does');
    const owned = does.flatMap((e) => (e.data as { stepIndexes: number[] }).stepIndexes);
    expect(owned).toHaveLength(d.steps.length);
  });

  test('committed fixture trace → distill → compact graph, valid end to end', () => {
    const data = readTrace(path.resolve('tests/fixtures/trace-demo/trace.zip'));
    const d = distill(data.events);
    const { graph } = compactFromDistillation(d, {
      graphId: 'fixture_compact', journeyId: 'fixture_demo', actors: { main: 'sales_user' },
    });
    expect(validateGraph(graph).errors).toEqual([]);
    expect(graph.edges.some((e) => e.type === 'does')).toBe(true);
    const sess = graph.nodes.find((n) => n.type === 'session')!;
    expect(sess.steps).toMatchObject({ status: 'captured', journeyId: 'fixture_demo' });
  });
});

test.describe('composite steps module', () => {
  test('source registers every does edge to replay its recorded slice', () => {
    const { graph } = compactFromDistillation(twoActorCapture(), OPTS);
    const src = graphStepsModuleSource(graph, 'lead_capture');
    expect(src).toContain('export function registerSteps_lead_capture(catalog: StepCatalog)');
    expect(src).toContain("import { registerSteps_lead_capture } from './lead_capture.steps'");
    expect(src).toContain("runJourneySlice(ctx, VOCAB, JOURNEY, [0, 1, 2, 3, 4])");
    expect(src).toContain("runJourneySlice(ctx, VOCAB, JOURNEY, [5, 6])");
    expect(src).toContain("journeys/generated/lead_capture.generated.json");
  });

  test('emitCaptureGraph writes graph + module to the given dirs', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'capg-'));
    const r = emitCaptureGraph(twoActorCapture(), OPTS, {
      graphs: path.join(tmp, 'graphs'), generated: path.join(tmp, 'gen'),
    });
    expect(fs.existsSync(r.graphFile)).toBe(true);
    expect(fs.existsSync(r.stepsFile)).toBe(true);
    const back = JSON.parse(fs.readFileSync(r.graphFile, 'utf8'));
    expect(validateGraph(back).errors).toEqual([]);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

test.describe('runJourneySlice', () => {
  test('replays exactly the indexed steps with placeholders resolved', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-'));
    const journeyFile = path.join(tmp, 'j.generated.json');
    fs.writeFileSync(journeyFile, JSON.stringify({
      journey: 'j',
      steps: [
        { actor: 'a', do: 'form.fill', with: { label: 'Last Name', value: 'static' } },
        { actor: 'a', do: 'form.fill', with: { label: 'Ref', value: '{ref:lead.id}' } },
        { actor: 'a', do: 'modal.save', with: { button: 'Save' } },
      ],
    }));

    const calls: { name: string; args: Record<string, unknown> }[] = [];
    const vocab = new StepCatalog()
      .register('form.fill', async ({ args }) => { calls.push({ name: 'form.fill', args }); })
      .register('modal.save', async ({ args }) => { calls.push({ name: 'modal.save', args }); });

    const ctx = {
      refs: { lead: { id: '00Q000ZZZ' } },
      args: {}, expects: {}, journey: { journey: 'j' }, stepIndex: 0,
    } as unknown as StepCtx;

    await runJourneySlice(ctx, vocab, journeyFile, [1, 2]);
    expect(calls).toEqual([
      { name: 'form.fill', args: { label: 'Ref', value: '00Q000ZZZ' } },
      { name: 'modal.save', args: { button: 'Save' } },
    ]);

    await expect(runJourneySlice(ctx, vocab, path.join(tmp, 'nope.json'), [0]))
      .rejects.toThrow(/journey file missing/);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
