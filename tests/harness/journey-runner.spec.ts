/**
 * End-to-end journey proof WITHOUT an org: the real runner drives the real
 * Cast (real browser contexts) through a segregation-of-duties journey over
 * an in-memory "org" whose state renders differently per persona — exactly
 * the multi-actor timeline a real Salesforce journey scripts, minus Salesforce.
 *
 * Proves: seed → actor step → deny (UI absence + API refusal) → second live
 * actor completes the flow → dual-layer verification — one test, two sessions
 * live at once, refusal recorded in the report.
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import { StepCatalog } from '../../src/journeys/catalog';
import { runJourney } from '../../src/journeys/runner';
import type { Journey } from '../../src/journeys/schema';
import type { SeedApi } from '../../src/data/seed';

const personasDoc = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  personas: {
    sales_user: { kind: 'internal', usernameEnv: 'SF_SALES_USERNAME' },
    admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME' },
  },
};

/** In-memory stand-in for the org: records + role-based capability checks. */
class FakeOrg {
  expenses = new Map<string, { status: string; approvedBy: string | null }>();
  private seq = 0;

  seedApi(): SeedApi {
    return {
      create: async (sobject) => {
        const id = `${sobject}-${++this.seq}`;
        this.expenses.set(id, { status: 'draft', approvedBy: null });
        return id;
      },
    };
  }

  submit(id: string): void {
    this.expenses.get(id)!.status = 'submitted';
  }

  /** Server-side rule: submitters cannot approve; admins can. */
  tryApprove(id: string, persona: string): { ok: boolean; status: number } {
    if (persona !== 'admin') return { ok: false, status: 403 };
    const rec = this.expenses.get(id)!;
    rec.status = 'approved';
    rec.approvedBy = persona;
    return { ok: true, status: 200 };
  }

  /** Role-based UI: the Approve control only renders for admins. */
  html(id: string, persona: string): string {
    const rec = this.expenses.get(id)!;
    const approve = persona === 'admin' ? '<button>Approve</button>' : '';
    return `<h1>Expense ${id}</h1><p>status: <span id="status">${rec.status}</span></p>${approve}`;
  }
}

test('expense approval cannot be gamed — full runner over live multi-actor sessions', async ({ browser }) => {
  const org = new FakeOrg();

  const authenticator = async (_personaId: string, b: Browser): Promise<BrowserContext> => b.newContext();
  const cast = new Cast(browser, { registry: PersonaRegistry.fromDoc(personasDoc), authenticator });

  const catalog = new StepCatalog()
    .register('expense.submit', async ({ page, args }) => {
      const id = String(args.expense);
      org.submit(id);
      await page.setContent(org.html(id, 'sales_user'));
      await expect(page.locator('#status')).toHaveText('submitted');
    })
    .register('expense.approve', async ({ page, args }) => {
      const id = String(args.expense);
      const verdict = org.tryApprove(id, 'admin');
      expect(verdict.ok).toBe(true);
      await page.setContent(org.html(id, 'admin'));
      await expect(page.locator('#status')).toHaveText('approved');
      await expect(page.getByRole('button', { name: 'Approve' })).toBeVisible();
    })
    .register('expense.verify', async ({ args }) => {
      // Dual-layer: the "SOQL" side — persisted state, not just what the UI said.
      const rec = org.expenses.get(String(args.expense))!;
      expect(rec.status).toBe('approved');
      expect(rec.approvedBy).toBe(String(args.expectApprover));
    })
    .registerDeny('expense.approve', ({ target }) => ({
      // UI probe: the control simply does not exist for the submitter…
      ui: async (page) => {
        await page.setContent(org.html(String(target), 'sales_user'));
        await expect(page.getByRole('button', { name: 'Approve' })).toHaveCount(0);
      },
      // …AND the API refuses the same attempt (belt and braces, catches UI-only security).
      api: async () => {
        const verdict = org.tryApprove(String(target), 'sales_user');
        return { denied: !verdict.ok, detail: `HTTP ${verdict.status}` };
      },
    }));

  const journey: Journey = {
    journey: 'expense_approval_sod_harness',
    actors: { submitter: 'sales_user', approver: 'admin' },
    invariants: [{ rule: 'distinctActors', actors: ['submitter', 'approver'] }],
    seed: [{ ref: 'expense', sobject: 'Expense', fields: { Name: '{unique:Exp}' } }],
    steps: [
      { actor: 'submitter', do: 'expense.submit', with: { expense: '{ref:expense.id}' } },
      { deny: { actor: 'submitter', capability: 'expense.approve', target: '{ref:expense.id}' } },
      { actor: 'approver', do: 'expense.approve', with: { expense: '{ref:expense.id}' }, timing: { notBefore: 'prevStep' } },
      { actor: 'approver', do: 'expense.verify', with: { expense: '{ref:expense.id}', expectApprover: 'admin' } },
    ],
  };

  try {
    const report = await runJourney(journey, {
      cast,
      api: org.seedApi(),
      catalog,
      personaIds: Object.keys(personasDoc.personas),
    });

    // Both sessions were genuinely live at once by the approve step:
    expect(cast.active().sort()).toEqual(['admin', 'sales_user']);

    expect(report.steps.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'do:expense.submit',
      'deny:expense.approve',
      'do:expense.approve',
      'do:expense.verify',
    ]);
    expect(report.steps[1]!.note).toBe('refusal proven');
    expect(report.flags).toEqual([]);

    // The server-side record really was approved by the approver, not the submitter:
    const [expense] = [...org.expenses.values()];
    expect(expense).toEqual({ status: 'approved', approvedBy: 'admin' });
  } finally {
    await cast.releaseAll();
  }
});

test('the same journey FAILS when the org leaks the capability', async ({ browser }) => {
  const org = new FakeOrg();
  // Sabotage: server-side rule removed — everyone can approve.
  org.tryApprove = (id: string, persona: string) => {
    const rec = org.expenses.get(id)!;
    rec.status = 'approved';
    rec.approvedBy = persona;
    return { ok: true, status: 200 };
  };

  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(personasDoc),
    authenticator: async (_id, b) => b.newContext(),
  });

  const catalog = new StepCatalog()
    .register('expense.submit', async ({ args }) => { org.submit(String(args.expense)); })
    .registerDeny('expense.approve', ({ target }) => ({
      api: async () => {
        const verdict = org.tryApprove(String(target), 'sales_user');
        return { denied: !verdict.ok, detail: `HTTP ${verdict.status}` };
      },
    }));

  const journey: Journey = {
    journey: 'leak_detector',
    actors: { submitter: 'sales_user' },
    seed: [{ ref: 'expense', sobject: 'Expense', fields: {} }],
    steps: [
      { actor: 'submitter', do: 'expense.submit', with: { expense: '{ref:expense.id}' } },
      { deny: { actor: 'submitter', capability: 'expense.approve', target: '{ref:expense.id}' } },
    ],
  };

  try {
    await expect(
      runJourney(journey, { cast, api: org.seedApi(), catalog, personaIds: ['sales_user', 'admin'] }),
    ).rejects.toThrow(/DENY FAILED \(API\).*HTTP 200/);
  } finally {
    await cast.releaseAll();
  }
});
