/**
 * R1 — the recording session (design doc §7.1 RECORDER, v1 trace-based).
 *
 * Run headed on your Mac:
 *   RECORD_PERSONA=sales_user RECORD_JOURNEY=expense_v2 npm run record
 * Drive the flow naturally; CLOSE THE BROWSER PAGE/WINDOW to finish.
 * Artifacts: recordings/<journey>/<persona>-<ts>/{trace.zip, network.har, manifest.json}
 *
 * Env-gated twice: skips without RECORD_* config, and (for authenticated
 * personas) without org credentials — so it never disturbs `npm run test:all`.
 * `--expect-denial` recordings: set RECORD_EXPECT_DENIAL=1 and drive AS THE
 * WRONG persona into the refusal (R5 distills it into a deny step).
 */
import { test } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
 
const { version: playwrightVersion } = require('@playwright/test/package.json') as { version: string };
import { Cast } from '../../src/fixtures/cast';
import { PersonaRegistry } from '../../src/personas/registry';
import {
  parseRecordEnv, recordingDirFor, buildManifest, HAR_URL_FILTER,
} from '../../src/pipeline/recording';
import { recordEvent } from '../../src/telemetry';

test('record a human-driven journey session', async ({ browser }) => {
  test.skip(!process.env.RECORD_PERSONA, 'set RECORD_PERSONA + RECORD_JOURNEY to record');
  test.setTimeout(0); // the human decides how long the session lasts

  const registry = PersonaRegistry.load();
  const parsed = parseRecordEnv(process.env, registry.ids());
  if (!parsed.ok) throw new Error(`recording config invalid:\n - ${parsed.errors.join('\n - ')}`);
  const cfg = parsed.value;

  if (!registry.hasCreds(cfg.persona)) {
    const hint = registry.missingEnvHint(cfg.persona);
     
    console.log(
      `\n⏸  cannot record yet — ${hint}\n` +
        `   1. copy .env.example → .env (once)\n` +
        `   2. fill the vars above for '${cfg.persona}' (org users: see SETUP-REAL-ORG.md)\n` +
        `   3. re-run:  RECORD_PERSONA=${cfg.persona} RECORD_JOURNEY=${cfg.journey} npm run record\n`,
    );
    test.skip(true, hint);
  }

  const startedAt = new Date();
  const dir = recordingDirFor(cfg.journey, cfg.persona, startedAt);
  fs.mkdirSync(dir, { recursive: true });

  const cast = new Cast(browser, {
    registry,
    contextOptions: {
      recordHar: { path: path.join(dir, 'network.har'), urlFilter: HAR_URL_FILTER },
    },
  });

  try {
    const page = await cast.as(cfg.persona);
    const context = cast.contextOf(cfg.persona);
    await context.tracing.start({ snapshots: true, screenshots: false });

     
    console.log(
      `\n▶ RECORDING '${cfg.journey}' as '${cfg.persona}'${cfg.expectDenial ? ' (expecting a DENIAL)' : ''}.` +
        `\n  Drive the flow naturally. Close the browser page/window to finish.\n`,
    );

    await page.waitForEvent('close', { timeout: 0 });

    await context.tracing.stop({ path: path.join(dir, 'trace.zip') });
    const manifest = buildManifest({
      env: cfg,
      startedAt,
      endedAt: new Date(),
      playwrightVersion,
    });
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    recordEvent({ kind: 'capture', id: cfg.journey, ms: Date.now() - startedAt.getTime() });
     
    console.log(`✔ recording saved: ${dir}`);
  } finally {
    await cast.releaseAll(); // closing contexts also flushes the HAR
  }
});
