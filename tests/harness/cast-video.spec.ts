/**
 * Per-persona video actually reaches the browser context.
 *
 * Playwright does not record contexts a test opens by hand, so Cast passes
 * `recordVideo` itself via contextOptionsFor(persona). This proves the chain
 * end to end with a real browser and a fake authenticator: a context built
 * from contextOptionsFor has `page.video()`, its file lands under
 * `<videoDir>/<persona>/`, and collectVideos orders it primary-actor-first.
 * With no videoDir nothing is recorded — the default stays cheap.
 */
import { test, expect } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import { collectVideos } from '../../src/studio/video';

const doc = {
  org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
  sites: {},
  accounts: { sub: {}, app: {} },
  personas: {
    submitter: { kind: 'internal', account: 'sub' },
    approver: { kind: 'internal', account: 'app' },
  },
};

/** The shape every authenticator must take: options come from the Cast. */
const authenticator = async (personaId: string, browser: Browser, cast: Cast): Promise<BrowserContext> =>
  browser.newContext(cast.contextOptionsFor(personaId));

test('with videoDir every persona records to its own folder, primary actor first', async ({ browser }) => {
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-video-'));
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(doc),
    authenticator,
    videoDir,
    videoSize: { width: 320, height: 240 },
  });
  try {
    const approver = await cast.as('approver'); // opens first → primary
    const submitter = await cast.as('submitter');
    expect(approver.video(), 'approver page records').not.toBeNull();
    expect(submitter.video(), 'submitter page records').not.toBeNull();
    await approver.setContent('<h1>approver</h1>');
    await submitter.setContent('<h1>submitter</h1>');
    expect(cast.sessionOrder).toEqual(['approver', 'submitter']);
    expect(cast.contextOptionsFor('approver').recordVideo).toEqual({
      dir: path.join(videoDir, 'approver'),
      size: { width: 320, height: 240 },
    });
    // The file name is known while the page is alive (Playwright names it at
    // page creation), so the stitching contract can be written before teardown.
    const early = await cast.videoManifest();
    expect(early.map((v) => v.persona)).toEqual(['approver', 'submitter']);
    expect(early[0]!.path.startsWith(path.join(videoDir, 'approver'))).toBe(true);
    expect(early[0]!.startedAt!).toBeLessThanOrEqual(early[1]!.startedAt!);
  } finally {
    await cast.releaseAll();
  }
  const videos = collectVideos(videoDir, cast.sessionOrder);
  expect(videos.map((v) => v.persona)).toEqual(['approver', 'submitter']);
  for (const v of videos) expect(fs.statSync(v.path).size).toBeGreaterThan(0);
  // manifest and disk agree file for file
  const manifest = await cast.videoManifest();
  expect(manifest.map((v) => v.path).sort()).toEqual(videos.map((v) => v.path).sort());
  fs.rmSync(videoDir, { recursive: true, force: true });
});

test('a second page in a persona context (popup) gets its own file and its own start time', async ({ browser }) => {
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-video-'));
  const cast = new Cast(browser, { registry: PersonaRegistry.fromDoc(doc), authenticator, videoDir });
  try {
    const page = await cast.as('submitter');
    await page.setContent('<a id="l" href="about:blank" target="_blank">open</a>');
    const [popup] = await Promise.all([cast.contextOf('submitter').waitForEvent('page'), page.click('#l')]);
    expect(popup.video()).not.toBeNull();
    const m = await cast.videoManifest();
    expect(m).toHaveLength(2);
    expect(m.every((v) => v.persona === 'submitter')).toBe(true);
    expect(new Set(m.map((v) => v.path)).size).toBe(2);
    expect(m[0]!.startedAt!).toBeLessThanOrEqual(m[1]!.startedAt!);
  } finally {
    await cast.releaseAll();
  }
  expect(collectVideos(videoDir)).toHaveLength(2);
  fs.rmSync(videoDir, { recursive: true, force: true });
});

test('without videoDir nothing records and contextOptionsFor is just the shared options', async ({ browser }) => {
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(doc),
    authenticator,
    contextOptions: { locale: 'en-NZ' },
  });
  try {
    const page = await cast.as('submitter');
    expect(page.video()).toBeNull();
    expect(cast.contextOptionsFor('submitter')).toEqual({ locale: 'en-NZ' });
    expect(cast.contextOptionsFor('submitter')).not.toBe(cast.contextOptions); // a copy, never the shared object
  } finally {
    await cast.releaseAll();
  }
});

test('contextOptionsFor keeps the shared options alongside recordVideo', async ({ browser }) => {
  const cast = new Cast(browser, {
    registry: PersonaRegistry.fromDoc(doc),
    authenticator,
    contextOptions: { locale: 'en-NZ' },
    videoDir: '/tmp/x',
  });
  expect(cast.contextOptionsFor('approver')).toEqual({ locale: 'en-NZ', recordVideo: { dir: path.join('/tmp/x', 'approver') } });
});
