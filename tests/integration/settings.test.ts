/**
 * Integration tests for the Settings module endpoints
 * (Wave 9 — SPEC.md §12).
 *
 * Validates: Requirements 11.1, 11.2, 11.3, 15.2, 15.3
 * Spec references: SPEC.md §12.1, §12.2, §16.2.
 *
 * Coverage matrix per SPEC §16.2 (happy / 401 / 403 / 400):
 *
 *   Verb / Endpoint           Happy   401   403                400
 *   GET   /api/settings         ✓      ✓     ✓ (employee)        —
 *   PATCH /api/settings         ✓      ✓     ✓ (employee)        ✓
 *
 * Per-endpoint specifics from SPEC §12.2:
 *   • GET masks sensitive keys (`anthropic_api_key`,
 *     `webhook_hmac_secret`) as `'***'` when a value is stored, `''`
 *     when not. Plaintext credentials NEVER leave the server.
 *   • PATCH encrypts sensitive values via `@/lib/crypto.encrypt()`
 *     before persisting (the stored row is NOT the plaintext).
 *   • PATCH treats the placeholder `'***'` as "leave the stored value
 *     alone" so a UI can naïvely round-trip GET → PATCH without
 *     leaking or re-rolling the credential.
 *
 * The integration setup file (`tests/integration/setup.ts`) stamps a
 * deterministic `ENCRYPTION_KEY` onto `process.env` so encrypt/decrypt
 * round-trip cleanly inside this suite.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GET, PATCH } from '@/app/api/settings/route';
import { POST as TEST_SMTP_POST } from '@/app/api/settings/test-smtp/route';
import { decrypt, encrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';
import { _resetMailerForTests } from '@/lib/mailer';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Nodemailer mock
// ---------------------------------------------------------------------------
//
// `POST /api/settings/test-smtp` instantiates a real nodemailer transport
// and calls `transport.sendMail(...)`. We intercept the entire `nodemailer`
// module so the suite never opens a TCP connection. The hoisted state
// (`mailerState`) lets each test configure what `sendMail` does (resolve
// with a fake messageId, or throw) and inspect the calls it received.

const { mailerState } = vi.hoisted(() => ({
  mailerState: {
    /** When non-null, `sendMail` rejects with this error. */
    nextError: null as Error | null,
    /** Captured `sendMail` argument objects, in call order. */
    sentMessages: [] as Array<{
      from?: string;
      to?: string;
      subject?: string;
      html?: string;
      text?: string;
    }>,
  },
}));

vi.mock('nodemailer', () => {
  const sendMail = vi.fn(
    async (args: { from?: string; to?: string; subject?: string; html?: string; text?: string }) => {
      mailerState.sentMessages.push(args);
      if (mailerState.nextError !== null) {
        throw mailerState.nextError;
      }
      return { messageId: '<test-message-id@example.test>' };
    },
  );
  const createTransport = vi.fn(() => ({ sendMail }));
  return {
    // `import nodemailer from 'nodemailer'` resolves to the default
    // export; `nodemailer.createTransport(...)` then walks through.
    default: { createTransport },
    createTransport,
  };
});

// ---------------------------------------------------------------------------
// Per-test reset for the mailer
// ---------------------------------------------------------------------------

beforeEach(() => {
  mailerState.nextError = null;
  mailerState.sentMessages.length = 0;
  // Drop the cached nodemailer transport so each test rebuilds it
  // against the fresh per-test Setting rows.
  _resetMailerForTests();
});

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await GET();
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin sessions', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET();
    expect(res.status).toBe(403);
  });

  it('returns every known key (empty for missing rows) for an admin', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await getJson<{ settings: Record<string, string> }>(res);
    // Every KNOWN_KEYS entry is present and defaults to empty strings.
    // Asserted as a superset so this test stays green when other
    // settings modules (Meta/Google ad-platform) extend `KNOWN_KEYS`
    // independently — each module owns its own integration suite.
    expect(body!.settings).toMatchObject({
      anthropic_api_key: '',
      webhook_hmac_secret: '',
      claude_model: '',
      daily_digest_hour: '',
      currency: '',
      hashtag_sets: '',
      followup_reminder_hour: '',
      smtp_host: '',
      smtp_port: '',
      smtp_user: '',
      smtp_pass: '',
      smtp_from: '',
    });
  });

  it('masks sensitive keys with `***` when a value is stored, returns plain values raw', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    // Seed a sensitive row (encrypted form is irrelevant — GET must
    // never decrypt) and a plain row (returned as-is).
    await prisma.setting.create({
      data: { key: 'anthropic_api_key', value: 'whatever-encrypted-blob' },
    });
    await prisma.setting.create({
      data: { key: 'claude_model', value: 'claude-sonnet-4-6' },
    });

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await getJson<{ settings: Record<string, string> }>(res);
    expect(body!.settings.anthropic_api_key).toBe('***');
    expect(body!.settings.claude_model).toBe('claude-sonnet-4-6');
    // Other sensitive key without a row stays empty (not `'***'`).
    expect(body!.settings.webhook_hmac_secret).toBe('');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings
// ---------------------------------------------------------------------------

describe('PATCH /api/settings — auth and validation', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'claude_model',
        value: 'claude-sonnet-4-6',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin sessions', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'claude_model',
        value: 'claude-sonnet-4-6',
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 on a malformed body shape (neither single nor bulk)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        // missing both `key`/`value` and `settings`
        nonsense: true,
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/settings — happy path', () => {
  it('persists a single plain key and writes a `setting.updated` activity log', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'claude_model',
        value: 'claude-sonnet-4-6',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      ok: boolean;
      updated: string[];
      errors: unknown[];
    }>(res);
    expect(body!.ok).toBe(true);
    expect(body!.updated).toEqual(['claude_model']);
    expect(body!.errors).toEqual([]);

    // Plain (non-sensitive) value is stored verbatim.
    const stored = await prisma.setting.findUnique({
      where: { key: 'claude_model' },
    });
    expect(stored!.value).toBe('claude-sonnet-4-6');

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'setting.updated',
        entityType: 'setting',
        entityId: 'claude_model',
      },
    });
    expect(log).not.toBeNull();
  });

  it('encrypts sensitive values before storing them', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const PLAINTEXT = 'sk-ant-test-fake-key-do-not-use';

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'anthropic_api_key',
        value: PLAINTEXT,
      }),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.setting.findUnique({
      where: { key: 'anthropic_api_key' },
    });
    expect(stored).not.toBeNull();
    // The stored value must NOT equal the plaintext — it should be an
    // AES-256-GCM ciphertext blob produced by `encrypt()`.
    expect(stored!.value).not.toBe(PLAINTEXT);
    expect(stored!.value.length).toBeGreaterThan(PLAINTEXT.length);
    // Round-tripping through `decrypt()` recovers the original value.
    expect(decrypt(stored!.value)).toBe(PLAINTEXT);
  });

  it('skips writes when a sensitive value is the placeholder `***`', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // First, store a real sensitive value.
    const initial = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'webhook_hmac_secret',
        value: 'real-hmac-secret-v1',
      }),
    );
    expect(initial.status).toBe(200);

    const before = await prisma.setting.findUnique({
      where: { key: 'webhook_hmac_secret' },
    });
    const beforeCipher = before!.value;

    // Then, simulate a UI round-trip that POSTs back the placeholder.
    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'webhook_hmac_secret',
        value: '***',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ updated: string[]; errors: unknown[] }>(res);
    // No-op: the placeholder is neither an update nor an error.
    expect(body!.updated).toEqual([]);
    expect(body!.errors).toEqual([]);

    const after = await prisma.setting.findUnique({
      where: { key: 'webhook_hmac_secret' },
    });
    // Stored ciphertext is byte-for-byte unchanged (the placeholder
    // path skips both validation rewrites and re-encryption).
    expect(after!.value).toBe(beforeCipher);
    expect(decrypt(after!.value)).toBe('real-hmac-secret-v1');
  });

  it('processes a bulk PATCH with mixed valid + unknown keys returning per-key errors', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        settings: {
          claude_model: 'claude-sonnet-4-6',
          currency: 'INR',
          unknown_key_xyz: 'whatever',
        },
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      ok: boolean;
      updated: string[];
      errors: Array<{ key: string; message: string }>;
    }>(res);
    expect(body!.ok).toBe(true);
    expect(body!.updated.sort()).toEqual(['claude_model', 'currency']);
    expect(body!.errors).toHaveLength(1);
    expect(body!.errors[0]!.key).toBe('unknown_key_xyz');

    // Both valid rows persisted.
    const claude = await prisma.setting.findUnique({
      where: { key: 'claude_model' },
    });
    expect(claude!.value).toBe('claude-sonnet-4-6');
    const currency = await prisma.setting.findUnique({
      where: { key: 'currency' },
    });
    expect(currency!.value).toBe('INR');
  });

  it('returns per-key errors for invalid values (e.g. out-of-range hour)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'daily_digest_hour',
        value: '99',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      updated: string[];
      errors: Array<{ key: string; message: string }>;
    }>(res);
    expect(body!.updated).toEqual([]);
    expect(body!.errors).toHaveLength(1);
    expect(body!.errors[0]!.key).toBe('daily_digest_hour');

    // No row was upserted.
    const stored = await prisma.setting.findUnique({
      where: { key: 'daily_digest_hour' },
    });
    expect(stored).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/settings — SMTP key surface
// ---------------------------------------------------------------------------

describe('PATCH /api/settings — SMTP', () => {
  it('persists smtp_host as a plain value', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'smtp_host',
        value: 'smtp.gmail.com',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      ok: boolean;
      updated: string[];
      errors: unknown[];
    }>(res);
    expect(body!.ok).toBe(true);
    expect(body!.updated).toEqual(['smtp_host']);

    const stored = await prisma.setting.findUnique({
      where: { key: 'smtp_host' },
    });
    // Non-sensitive — stored verbatim, never encrypted.
    expect(stored!.value).toBe('smtp.gmail.com');
  });

  it('encrypts smtp_pass before storing it', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const PLAINTEXT_PASS = 'app-specific-password-do-not-use';

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'smtp_pass',
        value: PLAINTEXT_PASS,
      }),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.setting.findUnique({
      where: { key: 'smtp_pass' },
    });
    expect(stored).not.toBeNull();
    // Stored ciphertext is NOT the plaintext.
    expect(stored!.value).not.toBe(PLAINTEXT_PASS);
    expect(stored!.value.length).toBeGreaterThan(PLAINTEXT_PASS.length);
    // Round-tripping decrypts back to the original value.
    expect(decrypt(stored!.value)).toBe(PLAINTEXT_PASS);
  });

  it('treats `***` in smtp_pass as "no change" once a value is stored', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // First, seed a real password.
    const first = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'smtp_pass',
        value: 'first-real-password',
      }),
    );
    expect(first.status).toBe(200);
    const before = await prisma.setting.findUnique({
      where: { key: 'smtp_pass' },
    });
    const beforeCipher = before!.value;

    // Then, simulate a UI round-trip that posts the placeholder.
    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'smtp_pass',
        value: '***',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ updated: string[]; errors: unknown[] }>(res);
    expect(body!.updated).toEqual([]);
    expect(body!.errors).toEqual([]);

    // Ciphertext is byte-for-byte unchanged.
    const after = await prisma.setting.findUnique({
      where: { key: 'smtp_pass' },
    });
    expect(after!.value).toBe(beforeCipher);
    expect(decrypt(after!.value)).toBe('first-real-password');
  });

  it('rejects an out-of-range smtp_port with a per-key error', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'smtp_port',
        value: '999999',
      }),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      updated: string[];
      errors: Array<{ key: string; message: string }>;
    }>(res);
    expect(body!.updated).toEqual([]);
    expect(body!.errors).toHaveLength(1);
    expect(body!.errors[0]!.key).toBe('smtp_port');

    const stored = await prisma.setting.findUnique({
      where: { key: 'smtp_port' },
    });
    expect(stored).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// POST /api/settings/test-smtp
// ---------------------------------------------------------------------------

/** Helper: persist a complete SMTP config (encrypted password) so the
 *  test-smtp route can resolve it without falling back to env vars. */
async function seedSmtpSettings(passPlaintext = 'app-password-secret'): Promise<void> {
  await prisma.setting.createMany({
    data: [
      { key: 'smtp_host', value: 'smtp.example.test' },
      { key: 'smtp_port', value: '587' },
      { key: 'smtp_user', value: 'alerts@example.test' },
      { key: 'smtp_pass', value: encrypt(passPlaintext) },
      { key: 'smtp_from', value: 'OfficePilot <alerts@example.test>' },
    ],
  });
}

describe('POST /api/settings/test-smtp', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await TEST_SMTP_POST(
      buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {}),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin sessions', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await TEST_SMTP_POST(
      buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {}),
    );
    expect(res.status).toBe(403);
  });

  it('returns 400 smtp_not_configured when no SMTP fields are set', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Make sure env vars don't accidentally fulfil the resolver. The
    // test harness doesn't seed them but a CI runner might.
    const originalEnv = {
      SMTP_HOST: process.env.SMTP_HOST,
      SMTP_PORT: process.env.SMTP_PORT,
      SMTP_USER: process.env.SMTP_USER,
      SMTP_PASS: process.env.SMTP_PASS,
      SMTP_FROM: process.env.SMTP_FROM,
    };
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    delete process.env.SMTP_FROM;

    try {
      const res = await TEST_SMTP_POST(
        buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {}),
      );
      expect(res.status).toBe(400);
      const body = await getJson<{ error: string }>(res);
      expect(body!.error).toBe('smtp_not_configured');
      // No mail was actually sent.
      expect(mailerState.sentMessages).toEqual([]);
    } finally {
      // Restore any env vars we cleared so unrelated tests aren't affected.
      for (const [k, v] of Object.entries(originalEnv)) {
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
    }
  });

  it('sends a test email and writes a settings.smtp_test_sent activity row on the happy path', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      email: 'admin-smtp-test@chitly.live',
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedSmtpSettings('correct-horse-battery-staple');

    const res = await TEST_SMTP_POST(
      buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {}),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ ok: boolean; sentTo: string }>(res);
    expect(body!.ok).toBe(true);
    expect(body!.sentTo).toBe('admin-smtp-test@chitly.live');

    // Exactly one mail went out to the admin's address.
    expect(mailerState.sentMessages).toHaveLength(1);
    const sent = mailerState.sentMessages[0]!;
    expect(sent.to).toBe('admin-smtp-test@chitly.live');
    expect(sent.from).toBe('OfficePilot <alerts@example.test>');
    expect(sent.subject).toContain('OfficePilot SMTP test');

    // Activity row recorded with the right action + payload.
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'settings.smtp_test_sent',
        entityType: 'setting',
        entityId: 'smtp',
      },
    });
    expect(log).not.toBeNull();
    const metadata = log!.metadata as { to?: string; ok?: boolean };
    expect(metadata.to).toBe('admin-smtp-test@chitly.live');
    expect(metadata.ok).toBe(true);
  });

  it('returns 502 smtp_send_failed and scrubs the password from the error message', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      email: 'admin-smtp-fail@chitly.live',
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedSmtpSettings('super-secret-pw-12345');

    // Make nodemailer's `sendMail` throw an error that leaks the
    // password — the route must scrub it before returning.
    mailerState.nextError = new Error(
      'AUTH failed: bad password super-secret-pw-12345 for user',
    );

    const res = await TEST_SMTP_POST(
      buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {}),
    );
    expect(res.status).toBe(502);
    const body = await getJson<{ error: string; message: string }>(res);
    expect(body!.error).toBe('smtp_send_failed');
    // The plaintext password MUST NOT appear in the response.
    expect(body!.message).not.toContain('super-secret-pw-12345');
    expect(body!.message).toContain('***');

    // Activity row logged with ok: false so audit shows the attempt.
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'settings.smtp_test_sent',
      },
    });
    expect(log).not.toBeNull();
    expect((log!.metadata as { ok?: boolean }).ok).toBe(false);
  });

  it('sends to an explicit recipient when `to` is provided in the body', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      email: 'admin-ignored@chitly.live',
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedSmtpSettings();

    const res = await TEST_SMTP_POST(
      buildJsonRequest('POST', 'http://test/api/settings/test-smtp', {
        to: 'someone-else@chitly.live',
      }),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ ok: boolean; sentTo: string }>(res);
    expect(body!.sentTo).toBe('someone-else@chitly.live');
    expect(mailerState.sentMessages[0]!.to).toBe('someone-else@chitly.live');
  });
});

// ---------------------------------------------------------------------------
// Ad-platform settings (Meta + Google Ads) — v0.1.3
// ---------------------------------------------------------------------------
//
// We mock `globalThis.fetch` at the test-block level: the route under
// test goes through `src/lib/integrations/*.ts`, which calls the built-in
// `fetch`. Stubbing it lets us pretend Meta / Google responded without
// opening a real socket. The `restoreAllMocks()` in afterEach undoes the
// spy so other integration suites in the same run don't inherit it.

describe('PATCH /api/settings — ad-platform persistence', () => {
  it('encrypts meta_access_token before storing it', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const PLAINTEXT = 'EAAB123-fake-meta-system-user-token';

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'meta_access_token',
        value: PLAINTEXT,
      }),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.setting.findUnique({
      where: { key: 'meta_access_token' },
    });
    expect(stored).not.toBeNull();
    // Stored ciphertext must NOT equal the plaintext — it should be an
    // AES-256-GCM blob produced by `encrypt()`.
    expect(stored!.value).not.toBe(PLAINTEXT);
    expect(stored!.value.length).toBeGreaterThan(PLAINTEXT.length);
    expect(decrypt(stored!.value)).toBe(PLAINTEXT);
  });

  it('returns a per-key error for an invalid meta_ad_account_id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'meta_ad_account_id',
        value: 'invalid',
      }),
    );
    // The PATCH endpoint accepts the body shape and returns per-key
    // errors with HTTP 200 — same convention as the existing hour /
    // currency validators.
    expect(res.status).toBe(200);

    const body = await getJson<{
      updated: string[];
      errors: Array<{ key: string; message: string }>;
    }>(res);
    expect(body!.updated).toEqual([]);
    expect(body!.errors).toHaveLength(1);
    expect(body!.errors[0]!.key).toBe('meta_ad_account_id');

    // Nothing got persisted for the bad key.
    const stored = await prisma.setting.findUnique({
      where: { key: 'meta_ad_account_id' },
    });
    expect(stored).toBeNull();
  });

  it('strips hyphens from google_ads_customer_id on save', async () => {
    // The validator is documented to strip hyphens so the stored form is
    // always the canonical 10-digit string. Callers that round-trip
    // through GET → PATCH won't see the hyphenated form come back.
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/settings', {
        key: 'google_ads_customer_id',
        value: '123-456-7890',
      }),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.setting.findUnique({
      where: { key: 'google_ads_customer_id' },
    });
    expect(stored!.value).toBe('1234567890');
  });
});

// ---------------------------------------------------------------------------
// POST /api/settings/test-meta
// ---------------------------------------------------------------------------

/** Helper: persist a complete Meta config (encrypted token) so the
 *  test-meta route can resolve it. */
async function seedMetaSettings(
  tokenPlaintext = 'EAAB-fake-meta-token',
): Promise<void> {
  await prisma.setting.createMany({
    data: [
      { key: 'meta_access_token', value: encrypt(tokenPlaintext) },
      { key: 'meta_ad_account_id', value: 'act_1234567890' },
    ],
    skipDuplicates: true,
  });
}

describe('POST /api/settings/test-meta', () => {
  // Lazy-load the route so the `vi.mock('nodemailer')` at the top of
  // the file doesn't accidentally affect a non-SMTP code path.
  let TEST_META_POST: typeof import('@/app/api/settings/test-meta/route').POST;

  beforeEach(async () => {
    const mod = await import('@/app/api/settings/test-meta/route');
    TEST_META_POST = mod.POST;
  });

  it('returns 400 meta_not_configured when no Meta credentials are set', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await TEST_META_POST();
    expect(res.status).toBe(400);

    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('meta_not_configured');
  });

  it('returns 200 + writes a settings.meta_test activity row on the happy path', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedMetaSettings('EAAB-real-token-do-not-use');

    // Stub `fetch` so we never actually hit graph.facebook.com.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: '987654321', name: 'My Business' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );

    try {
      const res = await TEST_META_POST();
      expect(res.status).toBe(200);

      const body = await getJson<{ ok: boolean; meName: string }>(res);
      expect(body!.ok).toBe(true);
      expect(body!.meName).toBe('My Business');

      // The route is supposed to hit Meta's `/me` endpoint exactly once.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const calledUrl = fetchSpy.mock.calls[0]![0];
      expect(String(calledUrl)).toContain('graph.facebook.com');
      expect(String(calledUrl)).toContain('/me');

      const log = await prisma.activityLog.findFirst({
        where: { userId: admin.id, action: 'settings.meta_test' },
      });
      expect(log).not.toBeNull();
      expect((log!.metadata as { ok?: boolean }).ok).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns 502 with Meta\'s error message when the API rejects the token', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedMetaSettings('EAAB-expired-token');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            message: 'Error validating access token: Session has expired.',
            type: 'OAuthException',
            code: 190,
          },
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      const res = await TEST_META_POST();
      expect(res.status).toBe(502);

      const body = await getJson<{ ok: boolean; error: string }>(res);
      expect(body!.ok).toBe(false);
      expect(body!.error).toContain('Session has expired');

      const log = await prisma.activityLog.findFirst({
        where: { userId: admin.id, action: 'settings.meta_test' },
      });
      expect(log).not.toBeNull();
      expect((log!.metadata as { ok?: boolean }).ok).toBe(false);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// POST /api/settings/test-google-ads
// ---------------------------------------------------------------------------

/** Helper: persist a complete Google Ads config so the test-google-ads
 *  route can resolve it. */
async function seedGoogleAdsSettings(): Promise<void> {
  await prisma.setting.createMany({
    data: [
      {
        key: 'google_ads_developer_token',
        value: encrypt('fake-developer-token'),
      },
      { key: 'google_ads_customer_id', value: '1234567890' },
      { key: 'google_ads_client_id', value: 'fake.apps.googleusercontent.com' },
      {
        key: 'google_ads_client_secret',
        value: encrypt('GOCSPX-fake-client-secret'),
      },
      {
        key: 'google_ads_refresh_token',
        value: encrypt('1//fake-refresh-token'),
      },
    ],
    skipDuplicates: true,
  });
}

describe('POST /api/settings/test-google-ads', () => {
  let TEST_GADS_POST: typeof import('@/app/api/settings/test-google-ads/route').POST;

  beforeEach(async () => {
    const mod = await import('@/app/api/settings/test-google-ads/route');
    TEST_GADS_POST = mod.POST;
  });

  it('returns 400 google_ads_not_configured when no credentials are set', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await TEST_GADS_POST();
    expect(res.status).toBe(400);

    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('google_ads_not_configured');
  });

  it('returns 200 + writes a settings.google_ads_test row when the OAuth refresh succeeds', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedGoogleAdsSettings();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: 'ya29.fake-short-lived-token',
          expires_in: 3599,
          scope: 'https://www.googleapis.com/auth/adwords',
          token_type: 'Bearer',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      const res = await TEST_GADS_POST();
      expect(res.status).toBe(200);

      const body = await getJson<{ ok: boolean; refreshOk: boolean }>(res);
      expect(body!.ok).toBe(true);
      expect(body!.refreshOk).toBe(true);

      // Confirm we hit Google's OAuth endpoint with a form-encoded body.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [calledUrl, init] = fetchSpy.mock.calls[0]!;
      expect(String(calledUrl)).toBe('https://oauth2.googleapis.com/token');
      expect(init?.method).toBe('POST');
      // The body is a `URLSearchParams.toString()` — assert all four
      // fields are present.
      const body2 = String((init as RequestInit | undefined)?.body ?? '');
      expect(body2).toContain('grant_type=refresh_token');
      expect(body2).toContain('client_id=fake.apps.googleusercontent.com');

      const log = await prisma.activityLog.findFirst({
        where: { userId: admin.id, action: 'settings.google_ads_test' },
      });
      expect(log).not.toBeNull();
      expect((log!.metadata as { ok?: boolean }).ok).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('returns 502 with Google\'s error_description when the refresh token is revoked', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });
    await seedGoogleAdsSettings();

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Token has been expired or revoked.',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    );

    try {
      const res = await TEST_GADS_POST();
      expect(res.status).toBe(502);

      const body = await getJson<{ ok: boolean; error: string }>(res);
      expect(body!.ok).toBe(false);
      expect(body!.error).toContain('expired or revoked');
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
