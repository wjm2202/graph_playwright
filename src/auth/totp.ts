/**
 * S14 — TOTP challenge codes from a shared secret. RFC 6238 over RFC 4226,
 * zero dependencies (node:crypto HMAC).
 *
 * "Any totp implementation" is the contract, so nothing is hard-coded:
 *  - algorithm sha1 (the near-universal default) / sha256 / sha512
 *  - any digit count (6 default) and period (30s default)
 *  - the secret may be RAW BASE32 ("JBSWY3DPEHPK3PXP", spaces/lowercase/
 *    padding tolerated) or the full otpauth:// URL an enrollment screen
 *    shows — parseOtpauth() honors its digits/period/algorithm params.
 *  - totpNow() waits out the period boundary when a code is about to
 *    expire, so a code is never submitted with <2s of life left.
 */
import { createHmac } from 'crypto';
import type { PersonaRegistry } from '../personas/registry';

export interface TotpOptions {
  digits?: number;
  periodSeconds?: number;
  algorithm?: 'sha1' | 'sha256' | 'sha512';
  /** Injectable clock for tests; defaults to Date.now(). */
  timestampMs?: number;
}

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 → bytes. Tolerant: case, spaces, dashes, padding. */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!cleaned) throw new Error('empty TOTP secret');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character '${ch}' in TOTP secret`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HOTP — HMAC + dynamic truncation. */
export function hotp(key: Buffer, counter: bigint, digits = 6, algorithm: 'sha1' | 'sha256' | 'sha512' = 'sha1'): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(counter);
  const mac = createHmac(algorithm, key).update(msg).digest();
  // HMAC digests are >=20 bytes and offset<=15 by construction (RFC 4226
  // dynamic truncation) — byte reads below cannot be out of range.
  const byte = (i: number): number => mac[i]!;
  const offset = byte(mac.length - 1) & 0x0f;
  const bin =
    ((byte(offset) & 0x7f) << 24) | (byte(offset + 1) << 16) | (byte(offset + 2) << 8) | byte(offset + 3);
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The current challenge code for a secret (base32 string or raw bytes). */
export function totp(secret: string | Buffer, opts: TotpOptions = {}): string {
  const key = typeof secret === 'string' ? base32Decode(secret) : secret;
  const period = opts.periodSeconds ?? 30;
  const counter = BigInt(Math.floor((opts.timestampMs ?? Date.now()) / 1000 / period));
  return hotp(key, counter, opts.digits ?? 6, opts.algorithm ?? 'sha1');
}

/** Seconds this period's code remains valid. */
export function secondsRemaining(opts: TotpOptions = {}): number {
  const period = opts.periodSeconds ?? 30;
  const seconds = Math.floor((opts.timestampMs ?? Date.now()) / 1000);
  return period - (seconds % period);
}

export interface OtpauthConfig extends TotpOptions {
  secret: string;
  label?: string;
  issuer?: string;
}

/** otpauth://totp/... as enrollment screens hand out — params honored. */
export function parseOtpauth(url: string): OtpauthConfig {
  const u = new URL(url);
  if (u.protocol !== 'otpauth:' || u.host !== 'totp') {
    throw new Error(`not a TOTP otpauth URL: ${u.protocol}//${u.host} (need otpauth://totp/...)`);
  }
  const secret = u.searchParams.get('secret');
  if (!secret) throw new Error('otpauth URL has no secret parameter');
  const algorithm = u.searchParams.get('algorithm')?.toLowerCase();
  if (algorithm && algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') {
    throw new Error(`unsupported otpauth algorithm '${algorithm}'`);
  }
  const digits = u.searchParams.get('digits');
  const period = u.searchParams.get('period');
  return {
    secret,
    ...(algorithm ? { algorithm: algorithm as 'sha1' | 'sha256' | 'sha512' } : {}),
    ...(digits ? { digits: Number(digits) } : {}),
    ...(period ? { periodSeconds: Number(period) } : {}),
    label: decodeURIComponent(u.pathname.replace(/^\//, '')),
    ...(u.searchParams.get('issuer') ? { issuer: u.searchParams.get('issuer')! } : {}),
  };
}

/** Raw base32 OR otpauth:// URL → the current code + its remaining life. */
export function totpFrom(secretOrUrl: string, opts: TotpOptions = {}): { code: string; secondsRemaining: number; config: TotpOptions } {
  const trimmed = secretOrUrl.trim();
  const config: TotpOptions = trimmed.startsWith('otpauth://')
    ? { ...parseOtpauth(trimmed), ...opts }
    : opts;
  const secret = trimmed.startsWith('otpauth://') ? parseOtpauth(trimmed).secret : trimmed;
  return { code: totp(secret, config), secondsRemaining: secondsRemaining(config), config };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * The code to TYPE right now: if the current one dies within
 * minValiditySeconds, wait for the next period so the challenge never sees
 * an expiring code mid-submit.
 */
export async function totpNow(secretOrUrl: string, opts: TotpOptions & { minValiditySeconds?: number } = {}): Promise<string> {
  const min = opts.minValiditySeconds ?? 2;
  const first = totpFrom(secretOrUrl, opts);
  if (first.secondsRemaining >= min || opts.timestampMs !== undefined) return first.code;
  await sleep(first.secondsRemaining * 1000 + 50);
  return totpFrom(secretOrUrl).code;
}

/** The persona-aware door: env name from personas.json, value from .env. */
export async function totpForPersona(
  registry: PersonaRegistry,
  personaId: string,
  env: NodeJS.ProcessEnv = process.env,
  workerIndex?: number,
): Promise<string> {
  const name = registry.envNamesFor(personaId, workerIndex).totp;
  if (!name) {
    throw new Error(`persona '${personaId}' has no totpEnv in personas.json — add one to answer TOTP challenges`);
  }
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`set ${name} in .env (the authenticator's base32 secret or its otpauth:// URL) — '${personaId}' cannot answer TOTP challenges without it`);
  }
  return totpNow(value);
}
