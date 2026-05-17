/**
 * AES-256-GCM symmetric encryption helpers for OfficePilot.
 *
 * Used by `src/app/api/settings/*` (encrypt before insert) and the various
 * code paths that read encrypted secrets from the `Setting` table — namely
 * the Anthropic API key (`Setting('anthropic_api_key')`) and the webhook
 * HMAC secret (`Setting('webhook_hmac_secret')`). See SPEC.md §12.2.
 *
 * Pure functions in the algebraic sense:
 *   • {@link decrypt} is deterministic — `decrypt(token)` always yields the
 *     same plaintext for a given token + key.
 *   • {@link encrypt} is non-deterministic by design: a fresh random 96-bit
 *     IV is generated per call (Property 2 in design.md §16.1). The
 *     output therefore differs across calls but always round-trips through
 *     {@link decrypt} (Property 1).
 *
 * No I/O beyond reading `process.env.ENCRYPTION_KEY`. No network, no disk,
 * no Prisma. Safe to use anywhere — route handlers, cron jobs, scripts.
 *
 * Wire format (base64-encoded for storage in Postgres TEXT columns):
 *
 *   ┌────────────────┬──────────────────┬──────────────────────────┐
 *   │ IV (12 bytes)  │ authTag (16 B)   │ ciphertext (variable)    │
 *   └────────────────┴──────────────────┴──────────────────────────┘
 *
 * Both lengths are fixed by AES-256-GCM, so the splitter is a constant-
 * offset slice (no length prefix required).
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCM,
  type DecipherGCM,
} from 'node:crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** AES-256-GCM uses a 256-bit (32-byte) key. */
const KEY_BYTES = 32;

/** NIST SP 800-38D recommends a 96-bit IV for GCM. */
const IV_BYTES = 12;

/** GCM authentication tag is 128 bits (16 bytes). */
const AUTH_TAG_BYTES = 16;

/** Hex-encoded 32 bytes is 64 characters. */
const KEY_HEX_LENGTH = KEY_BYTES * 2;

/** `node:crypto` algorithm string. */
const ALGORITHM = 'aes-256-gcm' as const;

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/**
 * Memoised key buffer keyed by the raw env string. Re-reads `process.env`
 * on every call so callers (and tests) can rotate the key by mutating the
 * environment, but avoids re-decoding hex on every encrypt/decrypt.
 */
let cachedKeyBuffer: Buffer | null = null;
let cachedKeySource: string | null = null;

/**
 * Read `process.env.ENCRYPTION_KEY`, validate it as 64 hex characters,
 * and return the 32-byte key buffer. Cached per env value.
 *
 * @throws {Error} when the env var is missing, empty, the wrong length,
 *                 or contains non-hex characters.
 */
function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY;

  if (raw == null || raw.length === 0) {
    throw new Error(
      'ENCRYPTION_KEY env var is missing. Set it to a 64-character hex string ' +
        '(generate with `openssl rand -hex 32`). See SPEC.md §15.',
    );
  }

  if (cachedKeyBuffer && cachedKeySource === raw) {
    return cachedKeyBuffer;
  }

  if (raw.length !== KEY_HEX_LENGTH) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly ${KEY_HEX_LENGTH} hex characters ` +
        `(${KEY_BYTES} bytes), got ${raw.length}. ` +
        'Generate with `openssl rand -hex 32`.',
    );
  }

  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    throw new Error(
      'ENCRYPTION_KEY must be a hex string (0-9, a-f). ' +
        'Generate with `openssl rand -hex 32`.',
    );
  }

  const buf = Buffer.from(raw, 'hex');
  if (buf.length !== KEY_BYTES) {
    // Defensive: should be unreachable given the regex + length checks above.
    throw new Error(
      `ENCRYPTION_KEY decoded to ${buf.length} bytes, expected ${KEY_BYTES}.`,
    );
  }

  cachedKeyBuffer = buf;
  cachedKeySource = raw;
  return buf;
}

// ---------------------------------------------------------------------------
// encrypt / decrypt
// ---------------------------------------------------------------------------

/**
 * Encrypt `plaintext` with AES-256-GCM under the key resolved from
 * `process.env.ENCRYPTION_KEY`. A fresh 96-bit IV is generated per call,
 * so two encrypts of the same plaintext produce two different ciphertexts.
 *
 * @param plaintext UTF-8 string to encrypt. May be empty.
 * @returns base64-encoded `iv (12 B) | authTag (16 B) | ciphertext`.
 * @throws {Error} when the encryption key is missing or malformed.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);

  const cipher: CipherGCM = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, authTag, ciphertext]).toString('base64');
}

/**
 * Decrypt a token produced by {@link encrypt}. Throws if the token is
 * malformed, the key is wrong, or the auth tag does not match the
 * ciphertext (any tamper detection failure surfaces as a thrown error
 * from `decipher.final()`).
 *
 * @param token base64-encoded `iv | authTag | ciphertext` string.
 * @returns the original UTF-8 plaintext.
 * @throws {Error} when the token is too short, the key is missing or
 *                 malformed, or the auth tag does not verify.
 */
export function decrypt(token: string): string {
  const key = getKey();

  const buf = Buffer.from(token, 'base64');
  if (buf.length < IV_BYTES + AUTH_TAG_BYTES) {
    throw new Error(
      `Invalid encrypted token: expected at least ${IV_BYTES + AUTH_TAG_BYTES} ` +
        `bytes (iv + authTag), got ${buf.length}.`,
    );
  }

  const iv = buf.subarray(0, IV_BYTES);
  const authTag = buf.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = buf.subarray(IV_BYTES + AUTH_TAG_BYTES);

  const decipher: DecipherGCM = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return plaintext.toString('utf8');
}
