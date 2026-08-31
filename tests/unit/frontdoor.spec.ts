import { test, expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildFrontdoorUrl, fetchSingleAccessUrl } from '../../src/auth/frontdoor';

test.describe('frontdoor', () => {
  test('buildFrontdoorUrl encodes token and retURL, tolerates trailing slash', () => {
    const url = buildFrontdoorUrl('https://x.my.salesforce.com/', 'tok/en+1', '/lightning/o/Account/list');
    expect(url).toBe(
      'https://x.my.salesforce.com/secur/frontdoor.jsp?sid=tok%2Fen%2B1&retURL=%2Flightning%2Fo%2FAccount%2Flist',
    );
  });

  test('buildFrontdoorUrl defaults retURL to lightning home', () => {
    expect(buildFrontdoorUrl('https://x.my.salesforce.com', 't')).toContain(
      'retURL=%2Flightning%2Fpage%2Fhome',
    );
  });
});

test.describe('fetchSingleAccessUrl', () => {
  function stubRequest(status: number, body: unknown) {
    const calls: { url: string; options: unknown }[] = [];
    const ctx = {
      post: async (url: string, options: unknown) => {
        calls.push({ url, options });
        return {
          ok: () => status >= 200 && status < 300,
          status: () => status,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      },
    } as unknown as APIRequestContext;
    return { ctx, calls };
  }

  test('posts token to /services/oauth2/singleaccess and returns frontdoor_uri', async () => {
    const { ctx, calls } = stubRequest(200, { frontdoor_uri: 'https://x/secur/frontdoor.jsp?otp=abc' });
    const uri = await fetchSingleAccessUrl(ctx, 'https://x.my.site.com/', 'tok');
    expect(uri).toBe('https://x/secur/frontdoor.jsp?otp=abc');
    expect(calls[0]!.url).toBe('https://x.my.site.com/services/oauth2/singleaccess');
    expect((calls[0]!.options as { form: Record<string, string> }).form.access_token).toBe('tok');
  });

  test('throws a diagnostic error on non-2xx (API-only user / wrong domain)', async () => {
    const { ctx } = stubRequest(400, { error: 'invalid_request' });
    await expect(fetchSingleAccessUrl(ctx, 'https://x.my.site.com', 'tok')).rejects.toThrow(
      /API-only|web\/full scope/,
    );
  });

  test('throws when response lacks frontdoor_uri', async () => {
    const { ctx } = stubRequest(200, {});
    await expect(fetchSingleAccessUrl(ctx, 'https://x.my.site.com', 'tok')).rejects.toThrow(
      /missing frontdoor_uri/,
    );
  });
});
