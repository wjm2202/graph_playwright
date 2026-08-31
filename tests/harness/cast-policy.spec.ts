/**
 * PG-3 — Cast session policies with real browser contexts: a Siebel-style
 * max-1 system logs out the least-recently-used session before the next
 * login on that system; unrestricted systems are untouched.
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';

const doc = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  personas: {
    siebel_admin: { kind: 'internal', usernameEnv: 'SIEBEL_ADMIN_USERNAME' },
    siebel_sales: { kind: 'internal', usernameEnv: 'SIEBEL_SALES_USERNAME' },
    sf_admin: { kind: 'internal', usernameEnv: 'SF_ADMIN_USERNAME' },
  },
};

function makeCast(browser: Browser, maxConcurrent: number) {
  const logins: string[] = [];
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(doc),
    authenticator: async (id, b): Promise<BrowserContext> => {
      logins.push(id);
      return b.newContext();
    },
    sessionPolicies: {
      groups: [{ system: 'siebel', maxConcurrent, personas: ['siebel_admin', 'siebel_sales'] }],
    },
  });
  return { cast, logins };
}

test('max-1 system: opening the second session logs the first out (LRU)', async ({ browser }) => {
  const { cast } = makeCast(browser, 1);
  try {
    const admin = await cast.as('siebel_admin');
    await cast.as('sf_admin'); // unrestricted system — irrelevant to the group
    const sales = await cast.as('siebel_sales');

    expect(admin.isClosed()).toBe(true); // logged out to comply
    expect(sales.isClosed()).toBe(false);
    expect(cast.evictions).toEqual(['siebel_admin']);
    expect(cast.active().sort()).toEqual(['sf_admin', 'siebel_sales']);
  } finally {
    await cast.releaseAll();
  }
});

test('LRU order respects recent use, and re-as() of a live persona never self-evicts', async ({ browser }) => {
  const { cast, logins } = makeCast(browser, 2);
  try {
    await cast.as('siebel_admin');
    await cast.as('siebel_sales');
    await cast.as('siebel_admin'); // touch admin — sales becomes LRU
    expect(cast.evictions).toEqual([]); // max 2: both fit
    expect(logins).toEqual(['siebel_admin', 'siebel_sales']); // cached, no re-login

    // Shrink the window by using a fresh cast with max 1 to check ordering:
    const tight = makeCast(browser, 1);
    try {
      await tight.cast.as('siebel_admin');
      const again = await tight.cast.as('siebel_admin'); // reuse, no eviction
      expect(tight.cast.evictions).toEqual([]);
      expect(again.isClosed()).toBe(false);
      await tight.cast.as('siebel_sales');
      expect(tight.cast.evictions).toEqual(['siebel_admin']);
      // Coming back logs admin in again — sales gets logged out this time:
      await tight.cast.as('siebel_admin');
      expect(tight.cast.evictions).toEqual(['siebel_admin', 'siebel_sales']);
      expect(tight.logins).toEqual(['siebel_admin', 'siebel_sales', 'siebel_admin']);
    } finally {
      await tight.cast.releaseAll();
    }
  } finally {
    await cast.releaseAll();
  }
});

test('unrestricted personas never trigger policy work', async ({ browser }) => {
  const { cast } = makeCast(browser, 1);
  try {
    await cast.as('sf_admin');
    await cast.as('siebel_admin');
    await cast.as('sf_admin');
    expect(cast.evictions).toEqual([]);
    expect(cast.active().sort()).toEqual(['sf_admin', 'siebel_admin']);
  } finally {
    await cast.releaseAll();
  }
});
