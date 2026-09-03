/**
 * S14 — TOTP helper against the RFC 6238 Appendix B test vectors (the
 * interop contract with "any totp implementation"), base32 tolerance,
 * otpauth:// parsing, and the persona-aware door.
 */
import { test, expect } from '@playwright/test';
import { base32Decode, hotp, parseOtpauth, secondsRemaining, totp, totpFrom, totpNow, totpForPersona } from '../../src/auth/totp';
import { PersonaRegistry } from '../../src/personas/registry';

// RFC 6238 seeds: the ASCII seed repeated out to the algorithm's key size.
const SEED20 = Buffer.from('12345678901234567890');
const SEED32 = Buffer.from('12345678901234567890123456789012');
const SEED64 = Buffer.from('1234567890123456789012345678901234567890123456789012345678901234');

test('RFC 6238 Appendix B vectors — sha1 / sha256 / sha512, 8 digits', () => {
  const at = (ms: number) => ({ digits: 8, timestampMs: ms });
  // T = 59s
  expect(totp(SEED20, { ...at(59_000), algorithm: 'sha1' })).toBe('94287082');
  expect(totp(SEED32, { ...at(59_000), algorithm: 'sha256' })).toBe('46119246');
  expect(totp(SEED64, { ...at(59_000), algorithm: 'sha512' })).toBe('90693936');
  // T = 1111111109s
  expect(totp(SEED20, { ...at(1_111_111_109_000), algorithm: 'sha1' })).toBe('07081804');
  expect(totp(SEED32, { ...at(1_111_111_109_000), algorithm: 'sha256' })).toBe('68084774');
  expect(totp(SEED64, { ...at(1_111_111_109_000), algorithm: 'sha512' })).toBe('25091201');
  // T = 2000000000s
  expect(totp(SEED20, { ...at(2_000_000_000_000), algorithm: 'sha1' })).toBe('69279037');
  expect(totp(SEED32, { ...at(2_000_000_000_000), algorithm: 'sha256' })).toBe('90698825');
  expect(totp(SEED64, { ...at(2_000_000_000_000), algorithm: 'sha512' })).toBe('38618901');
});

test('defaults are the wild-world defaults: 6 digits, 30s, sha1', () => {
  expect(totp(SEED20, { timestampMs: 59_000 })).toBe('287082'); // 8-digit vector truncated
  expect(hotp(SEED20, 1n)).toBe('287082'); // counter 1 == T 59s/30s
});

test('base32: lowercase, spaces, dashes, padding all tolerated; junk is named', () => {
  const canonical = base32Decode('JBSWY3DPEHPK3PXP');
  expect(base32Decode('jbsw y3dp ehpk 3pxp')).toEqual(canonical);
  expect(base32Decode('JBSW-Y3DP-EHPK-3PXP====')).toEqual(canonical);
  expect(canonical.toString('hex')).toBe('48656c6c6f21deadbeef'); // "Hello!" + 0xDEADBEEF
  expect(() => base32Decode('JBSW1')).toThrow(/invalid base32 character '1'/);
  expect(() => base32Decode('   ')).toThrow(/empty TOTP secret/);
});

test('otpauth:// URLs: params honored, non-totp refused', () => {
  const cfg = parseOtpauth('otpauth://totp/Acme:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA256&digits=8&period=60');
  expect(cfg).toMatchObject({ secret: 'JBSWY3DPEHPK3PXP', algorithm: 'sha256', digits: 8, periodSeconds: 60, issuer: 'Acme' });
  expect(cfg.label).toBe('Acme:me@example.com');
  expect(() => parseOtpauth('otpauth://hotp/x?secret=A')).toThrow(/need otpauth:\/\/totp/);
  expect(() => parseOtpauth('otpauth://totp/x')).toThrow(/no secret/);

  // totpFrom applies the URL's own config:
  const viaUrl = totpFrom('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=8&period=60&algorithm=SHA256', { timestampMs: 59_000 });
  expect(viaUrl.code).toBe(totp('JBSWY3DPEHPK3PXP', { digits: 8, periodSeconds: 60, algorithm: 'sha256', timestampMs: 59_000 }));
});

test('period boundary awareness', () => {
  expect(secondsRemaining({ timestampMs: 59_000 })).toBe(1);
  expect(secondsRemaining({ timestampMs: 60_000 })).toBe(30);
  expect(totpFrom('JBSWY3DPEHPK3PXP', { timestampMs: 59_000 }).secondsRemaining).toBe(1);
});

test('totpNow returns a live 6-digit code (never one about to die)', async () => {
  const code = await totpNow('JBSWY3DPEHPK3PXP');
  expect(code).toMatch(/^\d{6}$/);
  // with an injected clock it never sleeps — deterministic for callers/tests:
  expect(await totpNow('JBSWY3DPEHPK3PXP', { timestampMs: 59_000 })).toBe(totp('JBSWY3DPEHPK3PXP', { timestampMs: 59_000 }));
});

test('totpForPersona: the persona-aware door, with exact .env guidance', async () => {
  const reg = PersonaRegistry.fromDoc({
    org: { instanceUrlEnv: 'SF_INSTANCE_URL' },
    // `plain` switches TOTP off explicitly ('' = this login does not use it).
    accounts: { mfa: {}, plain: { totpEnv: '' } },
    personas: {
      mfa_user: { kind: 'internal', account: 'mfa' },
      plain_user: { kind: 'internal', account: 'plain' },
    },
  });
  expect(await totpForPersona(reg, 'mfa_user', { SF_MFA_TOTP_SECRET: 'JBSWY3DPEHPK3PXP' })).toMatch(/^\d{6}$/);
  await expect(totpForPersona(reg, 'mfa_user', {})).rejects.toThrow(/set SF_MFA_TOTP_SECRET in \.env/);
  await expect(totpForPersona(reg, 'plain_user', {})).rejects.toThrow(/has no totpEnv in personas\.json/);
});
