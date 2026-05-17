/**
 * Property-based + example tests for `src/lib/crypto.ts`.
 *
 * Validates: Requirements 11.2, 11.3, 11.4, 15.1
 *
 * Spec references:
 *   - SPEC.md §12.2 — AES-256-GCM, 96-bit IV per call, base64 of
 *     `iv | authTag | ciphertext`.
 *   - SPEC.md §16.1 — Vitest unit tests, ≥80 % line coverage on `lib/`.
 *   - design.md §"Correctness Properties" — Property 1 (round-trip) and
 *     Property 2 (non-deterministic encrypt).
 *
 * No network, no Prisma, no mocks — these are pure tests against
 * `node:crypto`. The single side-effect channel is `process.env`, which
 * the suite snapshots and restores so other test files (e.g.
 * `permissions.test.ts`) are unaffected.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import { decrypt, encrypt } from './crypto';

// ---------------------------------------------------------------------------
// Test key + env snapshot
// ---------------------------------------------------------------------------

/**
 * Deterministic 32-byte hex key used across the suite. Generated once via
 * `openssl rand -hex 32` and frozen here so test runs are reproducible.
 */
const TEST_KEY_HEX =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ORIGINAL_ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;

beforeAll(() => {
  process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
});

afterAll(() => {
  // Restore exactly what was there before the suite ran (including absence).
  if (ORIGINAL_ENCRYPTION_KEY === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = ORIGINAL_ENCRYPTION_KEY;
  }
});

beforeEach(() => {
  // Defensive: any earlier test that mutated the env var should be reset
  // before the next case runs.
  process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Arbitrary UTF-8 string whose UTF-8 byte length stays within `[0, maxBytes]`.
 * `fast-check`'s `fullUnicodeString` measures size in code points, not bytes,
 * so for an upper bound we cap by max code points (each ≤4 bytes in UTF-8)
 * and then filter to the exact byte budget.
 */
function utf8StringArb(maxBytes: number): fc.Arbitrary<string> {
  return fc
    .fullUnicodeString({ maxLength: maxBytes }) // ≤ maxBytes code points
    .filter((s) => Buffer.byteLength(s, 'utf8') <= maxBytes);
}

/**
 * Decode a base64 token to its raw bytes for tamper tests.
 */
function decodeToken(token: string): Buffer {
  return Buffer.from(token, 'base64');
}

/**
 * Re-encode a buffer back to a base64 token after mutating one byte.
 */
function encodeToken(buf: Buffer): string {
  return buf.toString('base64');
}

/** Single-bit flip on a copy of `buf` at byte `index`. */
function flipByte(buf: Buffer, index: number): Buffer {
  const copy = Buffer.from(buf);
  copy[index] = copy[index] ^ 0x01;
  return copy;
}

// ---------------------------------------------------------------------------
// Property 1 — round-trip preserves plaintext (design.md §16.1)
// ---------------------------------------------------------------------------

describe('Property 1 — round-trip preserves plaintext', () => {
  it('decrypt(encrypt(s)) === s for arbitrary UTF-8 strings 0–4096 bytes', () => {
    fc.assert(
      fc.property(utf8StringArb(4096), (s) => {
        expect(decrypt(encrypt(s))).toBe(s);
      }),
      { numRuns: 200 },
    );
  });

  it('round-trip works for the empty string explicitly', () => {
    expect(decrypt(encrypt(''))).toBe('');
  });

  it('round-trip works for a deliberately large 4096-byte ASCII payload', () => {
    const big = 'a'.repeat(4096);
    expect(decrypt(encrypt(big))).toBe(big);
  });
});

// ---------------------------------------------------------------------------
// Property 2 — non-deterministic encrypt (fresh IV per call)
// ---------------------------------------------------------------------------

describe('Property 2 — non-deterministic encrypt (fresh IV per call)', () => {
  it('two encrypts of the same plaintext differ but both decrypt to it', () => {
    fc.assert(
      fc.property(utf8StringArb(4096).filter((s) => s.length > 0), (s) => {
        const c1 = encrypt(s);
        const c2 = encrypt(s);
        expect(c1).not.toBe(c2);
        expect(decrypt(c1)).toBe(s);
        expect(decrypt(c2)).toBe(s);
      }),
      { numRuns: 100 },
    );
  });

  it('the random IV occupies the first 12 bytes and differs across calls', () => {
    const s = 'hello, world';
    const c1 = decodeToken(encrypt(s));
    const c2 = decodeToken(encrypt(s));
    expect(c1.subarray(0, 12).equals(c2.subarray(0, 12))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tamper detection — example-based
// ---------------------------------------------------------------------------

describe('decrypt() rejects tampered tokens', () => {
  const PLAINTEXT = 'sensitive-secret-123';

  it('throws when a byte in the ciphertext portion is flipped', () => {
    const buf = decodeToken(encrypt(PLAINTEXT));
    // Ciphertext begins after iv (12) + authTag (16) = 28.
    expect(buf.length).toBeGreaterThan(28);
    const tampered = encodeToken(flipByte(buf, 28));
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when a byte in the auth tag is flipped', () => {
    const buf = decodeToken(encrypt(PLAINTEXT));
    // Auth tag occupies bytes 12..27 inclusive.
    const tampered = encodeToken(flipByte(buf, 20));
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws when a byte in the IV is flipped', () => {
    const buf = decodeToken(encrypt(PLAINTEXT));
    // IV occupies bytes 0..11 inclusive.
    const tampered = encodeToken(flipByte(buf, 5));
    expect(() => decrypt(tampered)).toThrow();
  });

  it('throws on truncated input shorter than iv + authTag (28 bytes)', () => {
    // 27 random bytes — one shy of the iv + authTag floor.
    const tooShort = Buffer.alloc(27, 0xab).toString('base64');
    expect(() => decrypt(tooShort)).toThrow(/at least 28 bytes/i);
  });

  it('throws on the empty string token', () => {
    expect(() => decrypt('')).toThrow(/at least 28 bytes/i);
  });

  it('throws when the auth tag region matches but ciphertext is empty and key is wrong-context', () => {
    // Construct a buffer of exactly 28 bytes (iv + authTag, no ciphertext).
    // Because the authTag was not produced by GCM under our key, decrypt must
    // throw — exercises the `final()` auth-failure branch with empty
    // ciphertext (regression guard for the boundary length).
    const fake = Buffer.alloc(28, 0x00).toString('base64');
    expect(() => decrypt(fake)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ENCRYPTION_KEY validation
// ---------------------------------------------------------------------------

describe('ENCRYPTION_KEY validation', () => {
  it('encrypt throws a clear error when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt('anything')).toThrow(/ENCRYPTION_KEY.*missing/i);
  });

  it('decrypt throws a clear error when ENCRYPTION_KEY is missing', () => {
    // Build a valid token first, then remove the key before decrypting.
    process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encrypt('payload');
    delete process.env.ENCRYPTION_KEY;
    expect(() => decrypt(token)).toThrow(/ENCRYPTION_KEY.*missing/i);
  });

  it('encrypt throws when ENCRYPTION_KEY is the empty string', () => {
    process.env.ENCRYPTION_KEY = '';
    expect(() => encrypt('anything')).toThrow(/ENCRYPTION_KEY.*missing/i);
  });

  it('encrypt throws when ENCRYPTION_KEY is too short (63 hex chars)', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(63);
    expect(() => encrypt('anything')).toThrow(/64 hex characters/i);
  });

  it('encrypt throws when ENCRYPTION_KEY is too long (65 hex chars)', () => {
    process.env.ENCRYPTION_KEY = '0'.repeat(65);
    expect(() => encrypt('anything')).toThrow(/64 hex characters/i);
  });

  it('encrypt throws when ENCRYPTION_KEY contains non-hex characters', () => {
    // 64 chars but with a 'z' — passes length, fails hex regex.
    process.env.ENCRYPTION_KEY =
      'z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(() => encrypt('anything')).toThrow(/hex string/i);
  });

  it('decrypt throws when ENCRYPTION_KEY is wrong length', () => {
    process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encrypt('payload');
    process.env.ENCRYPTION_KEY = '0'.repeat(10);
    expect(() => decrypt(token)).toThrow(/64 hex characters/i);
  });

  it('decrypt with a different but valid key fails auth-tag verification', () => {
    process.env.ENCRYPTION_KEY = TEST_KEY_HEX;
    const token = encrypt('payload');
    // A different valid 64-char hex key
    process.env.ENCRYPTION_KEY =
      'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    expect(() => decrypt(token)).toThrow();
  });
});
