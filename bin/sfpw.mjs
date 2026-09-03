#!/usr/bin/env node
/**
 * sfpw — the repo's command line (Sprint 4.3).
 *
 * This file is deliberately thin and dependency-free at parse time: plain
 * ESM that runs on any Node ≥18, whose only job is to switch on TypeScript
 * execution and hand argv to src/cli/main.ts. The commands themselves are
 * ordinary TS modules under src/cli/, so the unit suite imports and tests
 * them directly instead of scraping a subprocess.
 *
 * TypeScript execution is tsx (a devDependency, esbuild under the hood).
 * BOTH hooks are registered: the ESM hook so this .mjs file can `import()` a
 * .ts entry point, and the CJS hook because — with no `"type": "module"` in
 * package.json — tsx transpiles src/*.ts to CommonJS, and their extensionless
 * relative imports (`./schema`) are resolved by the require hook. Registering
 * only one of the two fails with "Cannot find module './schema'".
 *
 *   sfpw --help            every command
 *   sfpw <command> --help  one command
 */
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

try {
  (await import('tsx/cjs/api')).register();
  (await import('tsx/esm/api')).register();
} catch (error) {
  process.stderr.write(
    `sfpw: cannot start the TypeScript loader (tsx). Run \`npm install\` first.\n` +
      `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
}

const { main } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'cli', 'main.ts')).href);

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
