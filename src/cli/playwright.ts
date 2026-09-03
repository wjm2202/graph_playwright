/**
 * The only place `sfpw` starts Playwright.
 *
 * Four things in this repo genuinely need a browser: recording a session,
 * simulating a run (evidence cards are rendered by a page), and the two
 * fixture generators. They stay Playwright specs; `sfpw` sets their env and
 * forwards the exit code, so the user still types one grammar.
 *
 * `--dry-run` prints the exact command instead of running it — that is how
 * the unit suite checks the wiring without starting a browser inside a test.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Cli } from './args';

export function runPlaywright(
  cli: Cli,
  argv: string[],
  env: Record<string, string>,
  dryRun: boolean,
): number {
  if (dryRun) {
    cli.out([...Object.entries(env).map(([k, v]) => `${k}=${v}`), 'playwright', ...argv].join(' '));
    return 0;
  }
  const local = path.join(cli.cwd, 'node_modules', '@playwright', 'test', 'cli.js');
  const useLocal = fs.existsSync(local);
  const command = useLocal ? process.execPath : 'npx';
  const args = useLocal ? [local, ...argv] : ['playwright', ...argv];
  const result = spawnSync(command, args, {
    cwd: cli.cwd,
    stdio: 'inherit',
    env: { ...cli.env, ...env },
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
