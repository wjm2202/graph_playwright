/**
 * Cast fixture mechanics, proven without an org: context = session, several
 * personas live at once with isolated cookie jars, cached logins, release
 * semantics, and deny() (the negative capability probe) in both directions.
 *
 * A fake authenticator stamps each context with an actor cookie — exactly the
 * shape a storageState-injected Salesforce sid takes, minus Salesforce.
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';

const doc = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: { portal: { urlEnv: 'SF_SITE_URL' } },
  accounts: { sub: {}, app: {} },
  personas: {
    submitter: { kind: 'internal', account: 'sub' },
    approver: { kind: 'internal', account: 'app' },
    guest: { kind: 'guest', site: 'portal' },
  },
};

function fakeAuth() {
  const authed: string[] = [];
  const authenticator = async (personaId: string, browser: Browser): Promise<BrowserContext> => {
    authed.push(personaId);
    const ctx = await browser.newContext();
    await ctx.addCookies([
      { name: 'actor_sid', value: `sid-${personaId}`, domain: 'example.test', path: '/' },
    ]);
    return ctx;
  };
  return { authed, authenticator };
}

function makeCast(browser: Browser, authenticator: (id: string, b: Browser) => Promise<BrowserContext>) {
  return new Cast(browser, {
    registry: PersonaRegistry.fromDoc(doc),
    authenticator: (id, b) => authenticator(id, b),
  });
}

test('two personas are live at once with isolated sessions', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    const submitter = await cast.as('submitter');
    const approver = await cast.as('approver');

    await submitter.setContent('<h1>submitter view</h1>');
    await approver.setContent('<h1>approver view</h1>');
    await expect(submitter.getByRole('heading', { name: 'submitter view' })).toBeVisible();
    await expect(approver.getByRole('heading', { name: 'approver view' })).toBeVisible();

    const subCookies = await cast.contextOf('submitter').cookies('https://example.test/');
    const appCookies = await cast.contextOf('approver').cookies('https://example.test/');
    expect(subCookies.map((c) => c.value)).toEqual(['sid-submitter']);
    expect(appCookies.map((c) => c.value)).toEqual(['sid-approver']);
    expect(cast.active().sort()).toEqual(['approver', 'submitter']);
  } finally {
    await cast.releaseAll();
  }
});

test('as() caches the session — one login per persona per test', async ({ browser }) => {
  const { authed, authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    const first = await cast.as('submitter');
    const second = await cast.as('submitter');
    expect(second).toBe(first);
    expect(authed).toEqual(['submitter']);
  } finally {
    await cast.releaseAll();
  }
});

test('release() is logout: context closes, next as() is a fresh login', async ({ browser }) => {
  const { authed, authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    const page = await cast.as('submitter');
    await cast.release('submitter');
    expect(page.isClosed()).toBe(true);
    expect(cast.active()).toEqual([]);

    await cast.as('submitter');
    expect(authed).toEqual(['submitter', 'submitter']);
  } finally {
    await cast.releaseAll();
  }
});

test('releaseAll() tears down every live session', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  const a = await cast.as('submitter');
  const b = await cast.as('approver');
  await cast.releaseAll();
  expect(a.isClosed()).toBe(true);
  expect(b.isClosed()).toBe(true);
  expect(cast.active()).toEqual([]);
});

test('unknown persona fails fast with the known ids', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  await expect(cast.as('auditor')).rejects.toThrow(/known: submitter, approver, guest/);
});

test('deny(ui): passes when the capability is absent for that persona', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    const page = await cast.as('submitter');
    await page.setContent('<button>Submit</button>'); // no Approve control rendered
    await cast.deny('submitter', {
      ui: async (p) => expect(p.getByRole('button', { name: 'Approve' })).toHaveCount(0),
    });
  } finally {
    await cast.releaseAll();
  }
});

test('deny(ui): FAILS loudly when the persona can actually do it', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    const page = await cast.as('submitter');
    await page.setContent('<button>Approve</button>'); // capability leaked!
    await expect(
      cast.deny('submitter', {
        ui: async (p) => expect(p.getByRole('button', { name: 'Approve' })).toHaveCount(0, { timeout: 500 }),
      }),
    ).rejects.toThrow(/DENY FAILED \(UI\).*submitter/);
  } finally {
    await cast.releaseAll();
  }
});

test('deny(api): server-side verdict is enforced both ways', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  try {
    await cast.deny('submitter', { api: async () => ({ denied: true, detail: '403 FORBIDDEN' }) });
    await expect(
      cast.deny('submitter', { api: async () => ({ denied: false, detail: '200 OK — approved!' }) }),
    ).rejects.toThrow(/DENY FAILED \(API\).*200 OK/);
  } finally {
    await cast.releaseAll();
  }
});

test('deny() with no probe layers is a spec bug, not a pass', async ({ browser }) => {
  const { authenticator } = fakeAuth();
  const cast = makeCast(browser, authenticator);
  await expect(cast.deny('submitter', {})).rejects.toThrow(/provide a ui and\/or api probe/);
});

test('guest persona uses the real authenticator path: empty state, no creds needed', async ({ browser }) => {
  // No fake here — the default ladder's guest branch is org-free by design.
  const cast = new Cast(browser, { registry: PersonaRegistry.fromDoc(doc), env: {} });
  try {
    const page = await cast.as('guest');
    const cookies = await cast.contextOf('guest').cookies();
    expect(cookies).toEqual([]);
    await page.setContent('<p>anonymous</p>');
    await expect(page.getByText('anonymous')).toBeVisible();
  } finally {
    await cast.releaseAll();
  }
});
