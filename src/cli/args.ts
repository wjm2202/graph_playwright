/**
 * Sprint 4.3 — argv, not env vars (review §3.2). One tiny parser shared by
 * every `sfpw` subcommand, so the grammar is the same everywhere:
 *
 *   sfpw <command> <positional…> [--flag] [--flag value|--flag=value] [-- …]
 *
 * Rules that matter more than features:
 *  - an unknown option is a USAGE error (exit 2), never a silent no-op —
 *    the whole point of retiring `GRILLME=` was that a typo used to "pass";
 *  - `--help` / `-h` is recognised at any position, by every command;
 *  - `--` ends sfpw's own parsing; the rest is passed through verbatim to
 *    whatever the command delegates to (Playwright, for `suite`).
 */

/** A user error: wrong command, wrong flags, missing argument. Exit code 2. */
export class UsageError extends Error {
  readonly usage: string | undefined;
  constructor(message: string, usage?: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

/** Everything a command writes goes through here, so tests can capture it. */
export interface Cli {
  /** Directory the command acts on (graphs, recordings, .env are read from here). */
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdout — the answer. */
  out: (line: string) => void;
  /** stderr — diagnostics, progress, errors. Never part of `--json` output. */
  err: (line: string) => void;
}

export type CommandRun = (argv: string[], cli: Cli) => number | Promise<number>;

export interface ArgSpec {
  /** `--name` with no value. */
  booleans?: string[];
  /** `--name value` or `--name=value`. */
  strings?: string[];
  /** Unrecognised options are collected instead of rejected (delegating commands). */
  passthrough?: boolean;
}

export interface Args {
  positionals: string[];
  flags: Record<string, string | boolean>;
  /** Everything after `--`, plus unknown options when `passthrough` is set. */
  passthrough: string[];
  help: boolean;
}

export function parseArgs(argv: string[], spec: ArgSpec = {}): Args {
  const booleans = new Set(spec.booleans ?? []);
  const strings = new Set(spec.strings ?? []);
  const args: Args = { positionals: [], flags: {}, passthrough: [], help: false };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] ?? '';
    if (token === '--') {
      args.passthrough.push(...argv.slice(i + 1));
      break;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? undefined : token.slice(eq + 1);
      if (booleans.has(name)) {
        if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
        args.flags[name] = true;
      } else if (strings.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined || (value.startsWith('-') && value.length > 1)) {
          throw new UsageError(`--${name} needs a value`);
        }
        args.flags[name] = value;
      } else if (spec.passthrough) {
        args.passthrough.push(token);
      } else {
        throw new UsageError(`unknown option '${token}'`);
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      if (!spec.passthrough) throw new UsageError(`unknown option '${token}'`);
      args.passthrough.push(token);
      continue;
    }
    args.positionals.push(token);
  }
  return args;
}

export function stringFlag(args: Args, name: string): string | undefined {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
}

export function boolFlag(args: Args, name: string): boolean {
  return args.flags[name] === true;
}

/** `sfpw <cmd> a b c` where only `a` is expected. */
export function noExtraPositionals(args: Args, allowed: number, command: string, usage: string): void {
  if (args.positionals.length > allowed) {
    throw new UsageError(
      `${command}: unexpected argument '${args.positionals[allowed] ?? ''}'`,
      usage,
    );
  }
}
