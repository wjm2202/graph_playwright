/**
 * Cast — multi-actor session machinery (design doc §2/§4 Option A).
 *
 * Core mechanic: Playwright context = Salesforce session. "Login" is
 * newContext({storageState}) (~100ms, no login UI); "logout" is closing the
 * context; several personas are live AT ONCE in a single test, which is what
 * makes segregation-of-duties journeys scriptable as one timeline.
 *
 * Auth ladder per persona (founding doc §4.1, sf_auth__strategy_hierarchy):
 *   1. reuse .auth/<persona>.json storageState if present AND young enough
 *      (SESSION_MAX_AGE_MS, default 2h — see auth/storage.ts)
 *   2. token → frontdoor (org) / UI Bridge singleaccess (site domain)
 *   3. username+password → one UI login, session persisted for reuse
 *   4. otherwise: fail with the exact .env vars to set
 * Guest personas get the explicit empty state.
 *
 * deny() is the anti-gaming half (design doc §3.2): a negative capability
 * probe — UI proof (control absent / refusal shown) and/or API proof (the
 * server refuses the same action for that persona). Journeys prove absence,
 * not just presence.
 */

import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PersonaRegistry } from '../personas/registry';
import { buildFrontdoorUrl, fetchSingleAccessUrl } from '../auth/frontdoor';
import { fillLoginForm } from '../auth/loginForm';
import { GUEST_STATE, sessionFreshness, sessionMaxAgeMs } from '../auth/storage';
import { totpNow } from '../auth/totp';
import { handleTotpChallenge } from '../auth/totp-challenge';
import { collectVideos, videoPolicy, videoSize } from '../studio/video';
import type { PersonaVideo, VideoOption } from '../studio/video';

export interface CastOptions {
  registry?: PersonaRegistry;
  /** Worker slot for pooled personas (testInfo.parallelIndex). */
  workerIndex?: number;
  /** Injectable session factory — harness tests fake it; e2e uses the real ladder. */
  authenticator?: Authenticator;
  env?: NodeJS.ProcessEnv;
  /**
   * Extra options for every context the default ladder creates (merged under
   * the ladder's own storageState choice). The recorder uses this for HAR
   * capture (R1); tracing rides the created context afterwards.
   */
  contextOptions?: BrowserContextOptions;
  /** Per-system session limits (derive from a process graph via
   *  sessionPoliciesFromGraph, or hand-build). */
  sessionPolicies?: SessionPolicies;
  /**
   * Record one video per persona session under `<videoDir>/<persona>/`.
   * Playwright never records manually created contexts (src/studio/video.ts),
   * so Cast does it: the `cast` fixture sets this from the `video` option and
   * attaches the files after teardown. Authenticators must build contexts
   * from `cast.contextOptionsFor(persona)` for this to take effect.
   */
  videoDir?: string;
  /** recordVideo frame size; Playwright's default when omitted. */
  videoSize?: { width: number; height: number };
}

export type Authenticator = (
  personaId: string,
  browser: Browser,
  cast: Cast,
) => Promise<BrowserContext>;

/** Session limits per SYSTEM (PG-3): personas grouped by the system they log
 *  into, with how many of those sessions may be live at once. Siebel-style
 *  systems get maxConcurrent 1 — Cast then "logs out to comply", releasing the
 *  least-recently-used session in the group before opening the next one. */
export interface SessionPolicyGroup {
  system: string;
  maxConcurrent: number;
  personas: string[];
}

export interface SessionPolicies {
  groups: SessionPolicyGroup[];
}

export interface DenyApiVerdict {
  denied: boolean;
  detail?: string;
}

export interface DenyProbe {
  /** Assert the UI refuses (control absent, error surface shown). Must resolve. */
  ui?: (page: Page) => Promise<void>;
  /** Attempt the operation server-side AS THAT PERSONA; report the verdict. */
  api?: () => Promise<DenyApiVerdict>;
}

export class Cast {
  readonly registry: PersonaRegistry;
  readonly workerIndex?: number;
  readonly env: NodeJS.ProcessEnv;
  readonly contextOptions: BrowserContextOptions;
  /** Not readonly: runGraph adopts the policies it derives from the graph
   *  (applySessionPolicies) before any session opens. */
  sessionPolicies?: SessionPolicies;
  /** Personas whose sessions were auto-released to satisfy a session policy. */
  readonly evictions: string[] = [];
  private readonly authenticator: Authenticator;
  private readonly contexts = new Map<string, BrowserContext>();
  private readonly pages = new Map<string, Page>();
  private readonly lastUsed = new Map<string, number>();
  private touch = 0;
  readonly videoDir?: string;
  private readonly videoSize?: { width: number; height: number };
  /** Personas in the order their FIRST session opened — the primary actor first. */
  readonly sessionOrder: string[] = [];
  /** Every page that recorded: its file and when it opened (videoManifest()). */
  private readonly videoLog: Promise<PersonaVideo | null>[] = [];

  constructor(private readonly browser: Browser, opts: CastOptions = {}) {
    this.registry = opts.registry ?? PersonaRegistry.load();
    if (opts.workerIndex !== undefined) this.workerIndex = opts.workerIndex;
    this.env = opts.env ?? process.env;
    this.contextOptions = opts.contextOptions ?? {};
    if (opts.sessionPolicies !== undefined) this.sessionPolicies = opts.sessionPolicies;
    if (opts.videoDir !== undefined) this.videoDir = opts.videoDir;
    if (opts.videoSize !== undefined) this.videoSize = opts.videoSize;
    this.authenticator = opts.authenticator ?? defaultAuthenticator;
  }

  /**
   * The options an authenticator must hand to `browser.newContext()` for
   * this persona: the shared `contextOptions` plus, when video is on, a
   * `recordVideo` dir of its own so the files can be attributed to the
   * persona afterwards. Callers may still spread their own keys on top
   * (the default ladder adds storageState).
   */
  contextOptionsFor(personaId: string): BrowserContextOptions {
    if (!this.videoDir) return { ...this.contextOptions };
    return {
      ...this.contextOptions,
      recordVideo: {
        dir: path.join(this.videoDir, personaId),
        ...(this.videoSize ? { size: this.videoSize } : {}),
      },
    };
  }

  /**
   * Adopt session limits derived from a process graph (runGraph calls this
   * before the first step). Sessions already live are NOT retro-evicted —
   * the limit governs every session opened from here on, which is why the
   * caller applies it before running.
   */
  applySessionPolicies(policies: SessionPolicies): void {
    this.sessionPolicies = policies;
  }

  /** Log in as persona (cached): returns that actor's Page. */
  async as(personaId: string): Promise<Page> {
    this.registry.get(personaId); // fail fast on unknown ids
    const existing = this.pages.get(personaId);
    if (existing && !existing.isClosed()) {
      this.lastUsed.set(personaId, ++this.touch);
      return existing;
    }

    let context = this.contexts.get(personaId);
    if (!context) {
      await this.enforceSessionPolicy(personaId);
      const openedAt = Date.now();
      context = await this.authenticator(personaId, this.browser, this);
      this.contexts.set(personaId, context);
      if (!this.sessionOrder.includes(personaId)) this.sessionOrder.push(personaId);
      // Video bookkeeping. A page the ladder already opened (UI login) started
      // recording right after newContext — openedAt is within the context's
      // own creation time of that. Pages opened from here on (the one below,
      // popups) are stamped as they appear.
      for (const p of context.pages()) this.registerVideo(personaId, p, openedAt);
      context.on('page', (p) => {
        this.registerVideo(personaId, p, Date.now());
      });
    }
    const page = context.pages()[0] ?? (await context.newPage());
    this.pages.set(personaId, page);
    this.lastUsed.set(personaId, ++this.touch);
    return page;
  }

  /**
   * Playwright names a page's video `<recordVideo.dir>/<page guid>.webm` and
   * hands the client that path at page creation (page.video().path() resolves
   * at once), so the file is known while the page is still alive; only its
   * bytes finish on context close. No video option → page.video() is null.
   */
  private registerVideo(personaId: string, page: Page, openedAt: number): void {
    const video = page.video();
    if (!video) return;
    this.videoLog.push(
      video
        .path()
        .then((file): PersonaVideo => ({ persona: personaId, path: file, startedAt: openedAt }))
        .catch(() => null),
    );
  }

  /**
   * Every recorded page, start order. Call after releaseAll() when the files
   * are final; before that the paths are valid but the bytes are not.
   */
  async videoManifest(): Promise<PersonaVideo[]> {
    const all = await Promise.all(this.videoLog);
    return all
      .filter((v): v is PersonaVideo => v !== null)
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  /** Logout-to-comply: before opening a session on a limited system, release
   *  the least-recently-used live session(s) in that system's group. */
  private async enforceSessionPolicy(personaId: string): Promise<void> {
    const group = this.sessionPolicies?.groups.find((g) => g.personas.includes(personaId));
    if (!group) return;
    for (;;) {
      const live = group.personas.filter((p) => p !== personaId && this.contexts.has(p));
      if (live.length < group.maxConcurrent) return;
      const lru = live.sort((a, b) => (this.lastUsed.get(a) ?? 0) - (this.lastUsed.get(b) ?? 0))[0];
      if (lru === undefined) return; // unreachable: live.length >= maxConcurrent >= 1
      this.evictions.push(lru);
      await this.release(lru);
    }
  }

  /** The persona's BrowserContext (for cookies, extra pages, tracing). */
  contextOf(personaId: string): BrowserContext {
    const ctx = this.contexts.get(personaId);
    if (!ctx) throw new Error(`persona '${personaId}' has no live session — call cast.as() first`);
    return ctx;
  }

  /** Personas with a live session right now. */
  active(): string[] {
    return [...this.contexts.keys()];
  }

  /** Logout: close the persona's context. Next as() starts a fresh session. */
  async release(personaId: string): Promise<void> {
    const ctx = this.contexts.get(personaId);
    this.contexts.delete(personaId);
    this.pages.delete(personaId);
    if (ctx) await ctx.close();
  }

  /** Test-end teardown: close every live session. */
  async releaseAll(): Promise<void> {
    const all = [...this.contexts.values()];
    this.contexts.clear();
    this.pages.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }

  /**
   * Negative capability probe: prove persona CANNOT do something.
   * Every provided layer must prove denial; at least one layer is required.
   * UI layer: your assertion of absence/refusal must pass on that persona's page.
   * API layer: the attempt must come back denied (e.g. 403, FLS-stripped).
   */
  async deny(personaId: string, probe: DenyProbe): Promise<void> {
    if (!probe.ui && !probe.api) {
      throw new Error(`deny('${personaId}'): provide a ui and/or api probe`);
    }
    if (probe.ui) {
      const page = await this.as(personaId);
      try {
        await probe.ui(page);
      } catch (e) {
        throw new Error(
          `DENY FAILED (UI): persona '${personaId}' was NOT refused — ${(e as Error).message}`,
        );
      }
    }
    if (probe.api) {
      const verdict = await probe.api();
      if (!verdict.denied) {
        throw new Error(
          `DENY FAILED (API): persona '${personaId}' was NOT refused server-side` +
            (verdict.detail ? ` — ${verdict.detail}` : ''),
        );
      }
    }
  }
}

/**
 * The real session ladder. Exported for the e2e setup project; harness tests
 * replace it entirely (no org in the loop).
 */
export const defaultAuthenticator: Authenticator = async (personaId, browser, cast) => {
  const { registry, env, workerIndex } = cast;
  const def = registry.get(personaId);

  if (def.kind === 'guest') {
    return browser.newContext({ ...cast.contextOptionsFor(personaId), storageState: GUEST_STATE as never });
  }

  const statePath = registry.statePathForPersona(personaId, workerIndex);
  if (fs.existsSync(statePath)) {
    // A cached session is trusted only while it's young enough to plausibly
    // still be valid — an old file otherwise surfaces as a baffling redirect
    // to a login page halfway through a test.
    const freshness = sessionFreshness(
      statePath,
      fs.statSync(statePath).mtimeMs,
      Date.now(),
      sessionMaxAgeMs(env),
    );
    if (freshness.fresh) {
      return browser.newContext({ ...cast.contextOptionsFor(personaId), storageState: statePath });
    }
    // The ladder's decisions are exactly what you debug at 2am.
    console.log(`· session cache: ${freshness.reason}`);
  }

  const creds = registry.resolveCreds(personaId, env, workerIndex);
  const domain = registry.authDomainFor(personaId, env);
  const context = await browser.newContext(cast.contextOptionsFor(personaId));
  const page = await context.newPage();

  try {
    if (creds.token) {
      // Tier 1: token injection. Org personas: classic frontdoor. Portal
      // personas: UI Bridge singleaccess on the SITE domain (single-use, ≤60s).
      const url =
        def.auth === 'singleaccess'
          ? await fetchSingleAccessUrl(context.request, domain, creds.token)
          : buildFrontdoorUrl(domain, creds.token);
      await page.goto(url);
      await page.waitForURL((u) => !/frontdoor\.jsp|\/login/.test(u.pathname), { timeout: 30_000 });
    } else if (creds.username && creds.password) {
      // Tier 2: one UI login, persisted. Org login page (or site login for
      // portals). fillLoginForm knows both Salesforce- and Siebel-shaped
      // markup, and settles on "the password field left the page" — the only
      // signal that works when a system (Siebel) swaps views without
      // changing its URL.
      const loginBase = def.kind === 'portal' ? `${domain}/login` : domain;
      await page.goto(loginBase);
      await fillLoginForm(page, { username: creds.username, password: creds.password });

      // MFA: when the org interposes a TOTP challenge, answer it from the
      // persona's totpEnv secret (base32 or otpauth:// URL). A challenge
      // with no secret fails LOUDLY with the exact .env name to set.
      const totpName = registry.envNamesFor(personaId, workerIndex).totp;
      const totpSecret = totpName ? env[totpName]?.trim() : undefined;
      const challenge = await handleTotpChallenge(page, {
        ...(totpSecret ? { getCode: () => totpNow(totpSecret) } : {}),
        detectTimeoutMs: 4000,
      });
      if (challenge === 'challenged-no-secret') {
        throw new Error(
          `'${personaId}' hit a verification (TOTP) challenge — set ${totpName ?? `totpEnv for '${personaId}' in personas.json, then that name`} in .env (the authenticator's base32 secret or otpauth:// URL)`,
        );
      }

      await page.waitForURL((u) => !/\/login|\/secur/.test(u.pathname), { timeout: 60_000 });
    } else {
      throw new Error(cast.registry.missingEnvHint(personaId, env, workerIndex));
    }

    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    await context.storageState({ path: statePath });
    return context;
  } catch (e) {
    await context.close().catch(() => undefined);
    throw e;
  }
};

// Fixture wiring: import { test } from this module to get { cast } + { lightning }.
import { test as lightningTest } from './test';

export const test = lightningTest.extend<{ cast: Cast }>({
  // `video` is Playwright's own option (use: { video }) — read here because
  // Playwright applies it only to its `context` fixture, never to the
  // contexts Cast opens (src/studio/video.ts). Cast records per persona;
  // after teardown every .webm is attached as `video`, primary actor first,
  // plus a `videos` manifest naming the persona behind each file.
  cast: async ({ browser, video }, use, testInfo) => {
    const policy = videoPolicy(video as VideoOption, testInfo.retry);
    const videoDir = policy.record ? testInfo.outputPath('videos') : undefined;
    const size = videoSize(video as VideoOption);
    const cast = new Cast(browser, {
      workerIndex: testInfo.parallelIndex,
      ...(videoDir ? { videoDir } : {}),
      ...(size ? { videoSize: size } : {}),
    });
    await use(cast);
    await cast.releaseAll(); // contexts closed → webm files are final
    if (!videoDir) return;
    if (!policy.keep(testInfo.status, testInfo.expectedStatus)) {
      fs.rmSync(videoDir, { recursive: true, force: true });
      return;
    }
    // Registered pages carry start times (the stitching contract); anything
    // else found on disk (a page Playwright opened that we never saw) is
    // still attached, after them, without a time.
    const registered = (await cast.videoManifest()).filter((v) => fs.existsSync(v.path));
    const seen = new Set(registered.map((v) => v.path));
    const videos = [...registered, ...collectVideos(videoDir, cast.sessionOrder).filter((v) => !seen.has(v.path))];
    for (const v of videos) {
      await testInfo.attach('video', { path: v.path, contentType: 'video/webm' });
    }
    if (videos.length) {
      await testInfo.attach('videos', {
        body: JSON.stringify(
          videos.map((v) => ({
            persona: v.persona,
            file: path.basename(v.path),
            ...(v.startedAt !== undefined ? { startedAt: v.startedAt } : {}),
          })),
        ),
        contentType: 'application/json',
      });
    }
  },
});

export { expect } from '@playwright/test';
