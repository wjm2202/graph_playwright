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

// tsx transpiles main.ts to CommonJS. Whether `import()` of that surfaces
// `main` as a NAMED export depends on Node's CJS export detection — it did on
// 22.23, it did not on 22.22 ("main is not a function"). The CJS namespace
// always carries module.exports as `default`, so accept either shape.
const mod = await import(pathToFileURL(path.join(HERE, '..', 'src', 'cli', 'main.ts')).href);
const main = typeof mod.main === 'function' ? mod.main : mod.default && typeof mod.default.main === 'function' ? mod.default.main : null;
if (!main) {
  process.stderr.write(`sfpw: src/cli/main.ts loaded but exported no main() — exports: ${Object.keys(mod).join(', ') || '(none)'}\n`);
  process.exit(1);
}

process.exitCode = await main(process.argv.slice(2), {
  cwd: process.cwd(),
  env: process.env,
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
