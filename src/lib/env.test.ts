/**
 * Unit tests for `src/lib/env.ts`.
 *
 * Validates: pre-deploy fix B5 — boot-time env-var validation must
 *   (a) accept a fully-populated production env,
 *   (b) reject a missing or malformed critical var with an aggregated
 *       error that names every offender,
 *   (c) relax presence checks when `NODE_ENV === 'test'` but keep format
 *       checks for any var that IS set,
 *   (d) warn-but-not-fail when the seed admin password is a known weak
 *       placeholder.
 *
 * All tests snapshot-and-restore `process.env` so cross-file ordering
 * (env.test.ts ↔ crypto.test.ts ↔ permissions.test.ts) doesn't leak
 * state. The `_resetEnvForTests()` hook drops the module-level cache
 * between cases so each test re-validates against its own env.
 *
 * No network, no Prisma, no mocks — pure validation logic against
 * `process.env`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetEnvForTests,
  env,
  validateEnv,
  validateSeedEnv,
} from './env';

// ---------------------------------------------------------------------------
// Env snapshot helpers
// ---------------------------------------------------------------------------

/**
 * A fully-valid production env. Tests start from this baseline and
 * mutate / delete individual keys to exercise failure paths.
 */
const VALID_PROD_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/officepilot',
  NEXTAUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY:
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  WEBHOOK_HMAC_SECRET: 'b'.repeat(32),
  CRON_SECRET: 'c'.repeat(32),
};

/**
 * Vars we touch in this test file. We snapshot exactly these on
 * `beforeEach` and restore them on `afterEach`, leaving everything else
 * (`PATH`, `HOME`, ...) untouched.
 */
const MANAGED_KEYS = [
  'NODE_ENV',
  'DATABASE_URL',
  'NEXTAUTH_SECRET',
  'ENCRYPTION_KEY',
  'WEBHOOK_HMAC_SECRET',
  'CRON_SECRET',
  'ANTHROPIC_API_KEY',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'MOCK_ANTHROPIC',
  'ADMIN_SEED_EMAIL',
  'ADMIN_SEED_PASSWORD',
] as const;

let snapshot: Partial<Record<(typeof MANAGED_KEYS)[number], string | undefined>> =
  {};

function snapshotEnv(): void {
  snapshot = {};
  for (const k of MANAGED_KEYS) {
    snapshot[k] = process.env[k];
  }
}

function restoreEnv(): void {
  // See `setEnv()` for why we widen `process.env`.
  const writable = process.env as Record<string, string | undefined>;
  for (const k of MANAGED_KEYS) {
    const v = snapshot[k];
    if (v === undefined) {
      delete writable[k];
    } else {
      writable[k] = v;
    }
  }
}

function setEnv(vars: Record<string, string | undefined>): void {
  // `@types/node` types `process.env.NODE_ENV` as a read-only union, so
  // we route mutations through a widened view of the env. The runtime
  // semantics are unchanged — `process.env` is a normal string map.
  const writable = process.env as Record<string, string | undefined>;
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) {
      delete writable[k];
    } else {
      writable[k] = v;
    }
  }
}

/** Clear every managed key — useful for "everything missing" tests. */
function clearAllManaged(): void {
  const writable = process.env as Record<string, string | undefined>;
  for (const k of MANAGED_KEYS) {
    delete writable[k];
  }
}

beforeEach(() => {
  snapshotEnv();
  _resetEnvForTests();
  // Silence the validator's own warnings by default so test output isn't
  // littered with `[env] ANTHROPIC_API_KEY is not set` messages. Tests
  // that assert on warnings install their own `vi.spyOn(console, 'warn')`
  // which clobbers this stub for the duration of the test.
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  restoreEnv();
  _resetEnvForTests();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// validateEnv() — happy path
// ---------------------------------------------------------------------------

describe('validateEnv() — happy path', () => {
  it('accepts a fully-populated production env', () => {
    clearAllManaged();
    setEnv(VALID_PROD_ENV);
    expect(() => validateEnv()).not.toThrow();
    const result = validateEnv();
    expect(result.DATABASE_URL).toBe(VALID_PROD_ENV.DATABASE_URL);
    expect(result.ENCRYPTION_KEY).toBe(VALID_PROD_ENV.ENCRYPTION_KEY);
    expect(result.NODE_ENV).toBe('production');
  });

  it('is idempotent — second call returns the same object', () => {
    clearAllManaged();
    setEnv(VALID_PROD_ENV);
    const a = validateEnv();
    const b = validateEnv();
    expect(a).toBe(b);
  });

  it('exposes optional ANTHROPIC_API_KEY when set', () => {
    clearAllManaged();
    setEnv({ ...VALID_PROD_ENV, ANTHROPIC_API_KEY: 'sk-ant-test' });
    const result = validateEnv();
    expect(result.ANTHROPIC_API_KEY).toBe('sk-ant-test');
  });

  it('warns when ANTHROPIC_API_KEY is missing in production', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearAllManaged();
    setEnv(VALID_PROD_ENV);
    validateEnv();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY is not set'),
    );
  });
});

// ---------------------------------------------------------------------------
// validateEnv() — failure aggregation
// ---------------------------------------------------------------------------

describe('validateEnv() — aggregated failures', () => {
  it('throws when every critical var is missing, listing all of them', () => {
    clearAllManaged();
    setEnv({ NODE_ENV: 'production' });
    let err: Error | null = null;
    try {
      validateEnv();
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    const msg = err!.message;
    expect(msg).toMatch(/DATABASE_URL/);
    expect(msg).toMatch(/NEXTAUTH_SECRET/);
    expect(msg).toMatch(/ENCRYPTION_KEY/);
    expect(msg).toMatch(/WEBHOOK_HMAC_SECRET/);
    expect(msg).toMatch(/CRON_SECRET/);
    // The error message should point readers at the example file.
    expect(msg).toMatch(/\.env\.example/);
  });

  it('throws when ENCRYPTION_KEY is the wrong length', () => {
    clearAllManaged();
    setEnv({ ...VALID_PROD_ENV, ENCRYPTION_KEY: '0'.repeat(63) });
    expect(() => validateEnv()).toThrow(/ENCRYPTION_KEY.*64 hex characters/);
  });

  it('throws when ENCRYPTION_KEY contains non-hex characters', () => {
    clearAllManaged();
    setEnv({
      ...VALID_PROD_ENV,
      ENCRYPTION_KEY:
        'z123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    });
    expect(() => validateEnv()).toThrow(/ENCRYPTION_KEY.*64 hex characters/);
  });

  it('throws when DATABASE_URL does not start with postgresql://', () => {
    clearAllManaged();
    setEnv({ ...VALID_PROD_ENV, DATABASE_URL: 'mysql://x' });
    expect(() => validateEnv()).toThrow(/DATABASE_URL.*postgresql/);
  });

  it('throws when NEXTAUTH_SECRET is too short', () => {
    clearAllManaged();
    setEnv({ ...VALID_PROD_ENV, NEXTAUTH_SECRET: 'short' });
    expect(() => validateEnv()).toThrow(/NEXTAUTH_SECRET/);
  });

  it('treats an empty-string env var as missing', () => {
    clearAllManaged();
    setEnv({ ...VALID_PROD_ENV, CRON_SECRET: '' });
    // The schema sees `undefined` (we coerce empty strings); the
    // required validator must therefore reject it.
    expect(() => validateEnv()).toThrow(/CRON_SECRET/);
  });

  it('throws when SMTP_PORT is set to a non-integer', () => {
    clearAllManaged();
    setEnv({
      ...VALID_PROD_ENV,
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 'not-a-number',
      SMTP_USER: 'user',
      SMTP_PASS: 'pass',
      SMTP_FROM: 'noreply@example.com',
    });
    expect(() => validateEnv()).toThrow(/SMTP_PORT.*positive integer/);
  });
});

// ---------------------------------------------------------------------------
// validateEnv() — NODE_ENV === 'test' relaxation
// ---------------------------------------------------------------------------

describe('validateEnv() — test-mode relaxation', () => {
  it('accepts a completely empty env when NODE_ENV=test', () => {
    clearAllManaged();
    setEnv({ NODE_ENV: 'test' });
    expect(() => validateEnv()).not.toThrow();
    const result = validateEnv();
    expect(result.NODE_ENV).toBe('test');
    // Unset critical vars fall back to '' in the cached record.
    expect(result.DATABASE_URL).toBe('');
  });

  it('still validates format of vars that ARE set in test mode', () => {
    clearAllManaged();
    setEnv({ NODE_ENV: 'test', ENCRYPTION_KEY: 'too-short' });
    expect(() => validateEnv()).toThrow(/ENCRYPTION_KEY/);
  });

  it('does not warn about missing ANTHROPIC_API_KEY in test mode', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearAllManaged();
    setEnv({ NODE_ENV: 'test' });
    validateEnv();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('ANTHROPIC_API_KEY'),
    );
  });
});

// ---------------------------------------------------------------------------
// Lazy `env` accessor
// ---------------------------------------------------------------------------

describe('env (lazy accessor)', () => {
  it('triggers validation on first property read', () => {
    clearAllManaged();
    setEnv(VALID_PROD_ENV);
    // Reading any property should not throw.
    expect(env.DATABASE_URL).toBe(VALID_PROD_ENV.DATABASE_URL);
    expect(env.NEXTAUTH_SECRET).toBe(VALID_PROD_ENV.NEXTAUTH_SECRET);
  });

  it('throws when accessed against an invalid env', () => {
    clearAllManaged();
    setEnv({ NODE_ENV: 'production' });
    expect(() => env.DATABASE_URL).toThrow(/Environment variable/);
  });
});

// ---------------------------------------------------------------------------
// validateSeedEnv()
// ---------------------------------------------------------------------------

describe('validateSeedEnv()', () => {
  it('accepts a valid seed env', () => {
    clearAllManaged();
    setEnv({
      ADMIN_SEED_EMAIL: 'admin@example.com',
      ADMIN_SEED_PASSWORD: 'StrongP@ssw0rd!2025',
    });
    const result = validateSeedEnv();
    expect(result.email).toBe('admin@example.com');
    expect(result.password).toBe('StrongP@ssw0rd!2025');
  });

  it('throws when ADMIN_SEED_EMAIL is missing', () => {
    clearAllManaged();
    setEnv({ ADMIN_SEED_PASSWORD: 'StrongP@ssw0rd!2025' });
    expect(() => validateSeedEnv()).toThrow(/ADMIN_SEED_EMAIL/);
  });

  it('throws when ADMIN_SEED_PASSWORD is too short', () => {
    clearAllManaged();
    setEnv({
      ADMIN_SEED_EMAIL: 'admin@example.com',
      ADMIN_SEED_PASSWORD: 'short',
    });
    expect(() => validateSeedEnv()).toThrow(/ADMIN_SEED_PASSWORD/);
  });

  it('warns but does not throw when password is a known weak placeholder', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearAllManaged();
    setEnv({
      ADMIN_SEED_EMAIL: 'admin@example.com',
      ADMIN_SEED_PASSWORD: 'ChangeMe!Now',
    });
    expect(() => validateSeedEnv()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/weak placeholder/i),
    );
  });

  it('does not warn when the password is strong and unique', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clearAllManaged();
    setEnv({
      ADMIN_SEED_EMAIL: 'admin@example.com',
      ADMIN_SEED_PASSWORD: 'X7!quBn4&fZh9k',
    });
    expect(() => validateSeedEnv()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/weak placeholder/i),
    );
  });
});
