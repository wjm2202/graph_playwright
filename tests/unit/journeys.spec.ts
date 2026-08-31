/**
 * Journey layer, browser-free: schema validation, catalog contracts, baseline
 * grading boundaries, and full runner orchestration against fakes.
 */
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as path from 'path';
import { validateJourney, type Journey } from '../../src/journeys/schema';
import { StepCatalog } from '../../src/journeys/catalog';
import {
  runJourney, gradeDuration, baselineKey, DEFAULT_BUDGETS,
  type Baselines, type CastLike,
} from '../../src/journeys/runner';
import type { SeedApi } from '../../src/data/seed';
import { validatePersonas } from '../../src/personas/schema';

const goodJourney = (): Journey => ({
  journey: 'expense_sod',
  actors: { submitter: 'sales_user', approver: 'admin' },
  invariants: [{ rule: 'distinctActors', actors: ['submitter', 'approver'] }],
  seed: [{ ref: 'acct', sobject: 'Account', fields: { Name: '{unique:A}' } }],
  steps: [
    { actor: 'submitter', do: 'expense.submit', with: { account: '{ref:acct.id}' } },
    { deny: { actor: 'submitter', capability: 'expense.approve', target: '{ref:acct.id}' } },
    { actor: 'approver', do: 'expense.approve', with: { account: '{ref:acct.id}' } },
  ],
});

function fakePage(): Page {
  return { __fake: 'page' } as unknown as Page;
}

function fakeCast() {
  const log: string[] = [];
  const denyCalls: { personaId: string; probe: unknown }[] = [];
  const cast: CastLike = {
    async as(personaId) {
      log.push(`as:${personaId}`);
      return fakePage();
    },
    async deny(personaId, probe) {
      denyCalls.push({ personaId, probe });
      log.push(`deny:${personaId}`);
      if (probe.api) {
        const verdict = await probe.api();
        if (!verdict.denied) throw new Error(`DENY FAILED (API): ${personaId}`);
      }
    },
  };
  return { cast, log, denyCalls };
}

function mockApi() {
  const created: string[] = [];
  let n = 0;
  const api: SeedApi = {
    async create(sobject) {
      created.push(sobject);
      return `ID${++n}`;
    },
  };
  return { api, created };
}

test.describe('validateJourney', () => {
  test('a well-formed journey passes', () => {
    expect(validateJourney(goodJourney()).errors).toEqual([]);
  });

  test('the shipped reference journey binds to shipped personas', () => {
     
    const journey = require(path.resolve(__dirname, '../../journeys/expense_approval_sod.json'));
     
    const personas = require(path.resolve(__dirname, '../../personas.json'));
    expect(validatePersonas(personas).ok).toBe(true);
    const r = validateJourney(journey, { personaIds: Object.keys(personas.personas) });
    expect(r.errors).toEqual([]);
  });

  test('unknown actor aliases in steps and invariants are caught', () => {
    const j = goodJourney();
    (j.steps[0] as { actor: string }).actor = 'ghost';
    j.invariants = [{ rule: 'distinctActors', actors: ['submitter', 'phantom'] }];
    const r = validateJourney(j);
    expect(r.errors.join()).toContain("steps[0].actor: unknown alias 'ghost'");
    expect(r.errors.join()).toContain("unknown alias 'phantom'");
  });

  test('unknown personas are caught when personaIds are provided', () => {
    const j = goodJourney();
    j.actors.approver = 'nonexistent';
    const r = validateJourney(j, { personaIds: ['sales_user', 'admin'] });
    expect(r.errors.join()).toContain("unknown persona 'nonexistent'");
  });

  test('deny steps require actor and capability', () => {
    const r = validateJourney({
      journey: 'x', actors: { a: 'admin' },
      steps: [{ deny: { actor: '', capability: '' } }],
    });
    expect(r.errors.join()).toContain('deny.actor');
    expect(r.errors.join()).toContain('deny.capability');
  });

  test('timing constraints are validated', () => {
    const j = goodJourney();
    (j.steps[2] as { timing?: unknown }).timing = { notBefore: 'whenever', maxDurationMs: -1 };
    const r = validateJourney(j);
    expect(r.errors.join()).toContain("only 'prevStep'");
    expect(r.errors.join()).toContain('maxDurationMs');
  });
});

test.describe('StepCatalog', () => {
  test('unknown entries fail with the known vocabulary', () => {
    const c = new StepCatalog().register('a.one', async () => {});
    expect(() => c.step('a.two')).toThrow(/unknown step 'a.two' — catalog has: a.one/);
    expect(() => c.denyProbe('x')).toThrow(/denials must be explicit/);
  });

  test('duplicate registration is a wiring bug', () => {
    const c = new StepCatalog().register('a', async () => {});
    expect(() => c.register('a', async () => {})).toThrow(/already registered/);
  });
});

test.describe('gradeDuration', () => {
  const b = { n: 10, meanMs: 500, p95Ms: 1000 };
  test('no baseline → ok (grading needs history, never guesses)', () => {
    expect(gradeDuration(99999, undefined)).toBe('ok');
  });
  test('boundaries: ≤soft ok, >soft flag, >hard fail', () => {
    expect(gradeDuration(1500, b)).toBe('ok'); // exactly p95×1.5 is within budget
    expect(gradeDuration(1501, b)).toBe('soft');
    expect(gradeDuration(3000, b)).toBe('soft'); // exactly ×3 still soft
    expect(gradeDuration(3001, b)).toBe('hard');
  });
  test('budgets are overridable', () => {
    expect(gradeDuration(1100, b, { softFactor: 1.0, hardFactor: 1.05 })).toBe('hard');
  });
  test('baselineKey matches the design-doc shape', () => {
    expect(baselineKey(3, 'approver', 'expense.approve')).toBe('3:approver/expense.approve');
    expect(DEFAULT_BUDGETS).toEqual({ softFactor: 1.5, hardFactor: 3.0 });
  });
});

test.describe('runJourney orchestration', () => {
  function catalogRecording(order: string[]) {
    return new StepCatalog()
      .register('expense.submit', async (ctx) => {
        order.push(`submit@${ctx.stepIndex}:${String(ctx.args.account)}`);
      })
      .register('expense.approve', async (ctx) => {
        order.push(`approve@${ctx.stepIndex}:${String(ctx.args.account)}`);
      })
      .registerDeny('expense.approve', (ctx) => ({
        api: async () => ({ denied: true, detail: `probe on ${String(ctx.target)}` }),
      }));
  }

  test('runs seed → steps → denies in order with resolved refs', async () => {
    const order: string[] = [];
    const { cast, log, denyCalls } = fakeCast();
    const { api, created } = mockApi();

    const report = await runJourney(goodJourney(), { cast, api, catalog: catalogRecording(order) });

    expect(created).toEqual(['Account']);
    expect(order).toEqual(['submit@0:ID1', 'approve@2:ID1']); // seeded id flowed into args
    expect(log).toEqual(['as:sales_user', 'deny:sales_user', 'as:admin']);
    expect(denyCalls[0]!.personaId).toBe('sales_user');
    expect(report.steps.map((s) => s.kind)).toEqual(['do', 'deny', 'do']);
    expect(report.steps[1]!.note).toBe('refusal proven');
    expect(report.flags).toEqual([]);
  });

  test('distinctActors invariant blocks execution BEFORE any step runs', async () => {
    const j = goodJourney();
    j.actors.approver = 'sales_user'; // same human holds both roles
    const order: string[] = [];
    const { cast, log } = fakeCast();
    const { api } = mockApi();
    await expect(runJourney(j, { cast, api, catalog: catalogRecording(order) })).rejects.toThrow(
      /distinctActors violated.*sales_user/,
    );
    expect(order).toEqual([]);
    expect(log).toEqual([]);
  });

  test('a leaked capability fails the journey at the deny step', async () => {
    const catalog = new StepCatalog()
      .register('expense.submit', async () => {})
      .register('expense.approve', async () => {})
      .registerDeny('expense.approve', () => ({
        api: async () => ({ denied: false, detail: 'submitter approved own expense!' }),
      }));
    const { cast } = fakeCast();
    const { api } = mockApi();
    await expect(runJourney(goodJourney(), { cast, api, catalog })).rejects.toThrow(/DENY FAILED/);
  });

  test('seed block without an api is an explicit error', async () => {
    const { cast } = fakeCast();
    await expect(
      runJourney(goodJourney(), { cast, catalog: catalogRecording([]) }),
    ).rejects.toThrow(/has a seed block — provide deps.api/);
  });

  test('soft budget overrun flags but passes; hard overrun fails fast with expected-vs-actual', async () => {
    const j = goodJourney();
    j.seed = [];
    j.steps = [{ actor: 'submitter', do: 'expense.submit' }];
    const { cast } = fakeCast();
    const catalog = new StepCatalog()
      .register('expense.submit', async () => {})
      .registerDeny('expense.approve', () => ({ api: async () => ({ denied: true }) }));

    let t = 0;
    const clock = () => (t += 1000); // every step measures 1000ms

    const soft: Baselines = { journey: 'expense_sod', steps: { '0:submitter/expense.submit': { n: 5, meanMs: 500, p95Ms: 600 } } };
    const report = await runJourney(j, { cast, catalog, baselines: soft, clock });
    expect(report.steps[0]!.status).toBe('soft-flag');
    expect(report.flags[0]).toContain('baseline p95 600ms');

    t = 0;
    const hard: Baselines = { journey: 'expense_sod', steps: { '0:submitter/expense.submit': { n: 5, meanMs: 100, p95Ms: 200 } } };
    await expect(runJourney(j, { cast, catalog, baselines: hard, clock })).rejects.toThrow(
      /blew the timing budget: 1000ms vs baseline p95 200ms.*expected ≤ 600ms/,
    );
  });

  test('timing.maxDurationMs is a hard ceiling independent of baselines', async () => {
    const j = goodJourney();
    j.seed = [];
    j.steps = [{ actor: 'submitter', do: 'expense.submit', timing: { maxDurationMs: 500 } }];
    const { cast } = fakeCast();
    const catalog = new StepCatalog().register('expense.submit', async () => {});
    let t = 0;
    const clock = () => (t += 1000);
    await expect(runJourney(j, { cast, catalog, clock })).rejects.toThrow(
      /exceeded its hard ceiling: 1000ms > maxDurationMs 500ms/,
    );
  });

  test('timing.waitMs choreography uses the injected sleeper', async () => {
    const j = goodJourney();
    j.seed = [];
    j.steps = [{ actor: 'submitter', do: 'expense.submit', timing: { waitMs: 2500 } }];
    const { cast } = fakeCast();
    const catalog = new StepCatalog().register('expense.submit', async () => {});
    const slept: number[] = [];
    await runJourney(j, { cast, catalog, sleep: async (ms) => { slept.push(ms); } });
    expect(slept).toEqual([2500]);
  });

  test('an invalid journey never executes', async () => {
    const { cast, log } = fakeCast();
    await expect(
      runJourney({ journey: 'Bad Name', actors: {}, steps: [] }, {
        cast,
        catalog: new StepCatalog(),
      }),
    ).rejects.toThrow(/invalid/);
    expect(log).toEqual([]);
  });
});
