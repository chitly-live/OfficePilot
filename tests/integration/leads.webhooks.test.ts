/**
 * Integration tests for `POST /api/webhooks/leads` (task 35).
 *
 * Validates: Requirements 5.10, 5.11, 15.2, 15.3, 15.4
 * Spec references: SPEC.md §6.2.8, §6.3, §11.1, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + task 35 brief:
 *
 *   Property 4 — HMAC verification is signature-correct (single-byte flip → 401)
 *   Happy path — valid signature → 201 + DB row, both `sha256=<hex>` and bare `<hex>` formats
 *   Auth failures — missing header, empty value, wrong length, non-hex, wrong-secret → 401
 *   Server config — secret unset → 500, no admin → 500
 *   Body validation — invalid JSON → 400, schema failure → 400 with `issues`
 *   Idempotency — dedupe within 24h → 200 + `{ deduplicated: true }`, single Lead row
 *   Persistence — source mapping, ownerId=null, createdById=oldest admin, UTM, tags
 *   Activity log — `lead.webhook_received` row with metadata
 *
 * The route handler reads only `req.text()` and `req.headers.get()`, so we
 * skip Next.js's `NextRequest` wrapper (no `.nextUrl` needed) and feed
 * plain `Request` instances cast to the handler's parameter type. Per-test
 * DB cleanup is handled by `tests/integration/setup.ts`'s `beforeEach`.
 */

import crypto from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import type { NextRequest } from 'next/server';
import { LeadSource } from '@prisma/client';

import { POST } from '@/app/api/webhooks/leads/route';
import { prisma } from '@/lib/db';

import { createTestUser, getJson } from './helpers';

// ---------------------------------------------------------------------------
// Per-file constants + helpers
// ---------------------------------------------------------------------------

/**
 * Stable secret used by every test in this file. Mirrors what
 * `tests/integration/setup.ts` stamps onto `process.env.WEBHOOK_HMAC_SECRET`,
 * but pinned locally so the value is visible at the call site (and the
 * "secret unset" test below can delete the env var without breaking the
 * next test — `beforeEach` re-stamps it).
 */
const TEST_SECRET = 'test-webhook-hmac-secret-do-not-use-in-prod';

/** Endpoint URL; the route handler doesn't actually look at it. */
const URL_STR = 'http://test/api/webhooks/leads';

/** Hex digit alphabet, used both for length checks and the property test. */
const HEX_DIGITS = '0123456789abcdef';

/** SHA-256 digests are 64 hex chars (32 bytes × 2). */
const HEX_LEN = 64;

beforeEach(() => {
  // Re-arm the env var on every test so the "secret unset" test can
  // safely delete it without leaking that state into the next test.
  process.env.WEBHOOK_HMAC_SECRET = TEST_SECRET;
});

afterEach(() => {
  // Defensive: regardless of what an individual test did, restore the
  // canonical secret so the suite doesn't accumulate side-effects.
  process.env.WEBHOOK_HMAC_SECRET = TEST_SECRET;
});

/** Compute the canonical HMAC-SHA256 hex digest of `body` under `secret`. */
function computeSignature(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

interface BuildOptions {
  /** Raw body bytes used both as request body and as HMAC input. */
  rawBody?: string;
  /** Override the computed signature with an explicit value (or empty). */
  signature?: string;
  /** Omit the `x-signature` header entirely. */
  omitSignature?: boolean;
  /** Send `x-signature: sha256=<hex>` instead of bare hex. */
  withPrefix?: boolean;
  /** HMAC secret used to sign — defaults to `TEST_SECRET`. */
  secret?: string;
}

/**
 * Build a webhook `Request` ready for the route handler. The handler
 * only reaches into `req.text()` and `req.headers.get('x-signature')`,
 * so we don't bother with Next.js's `NextRequest` wrapper — a plain
 * `Request` cast to the handler's parameter type suffices.
 */
function buildWebhookRequest(
  payload: unknown,
  opts: BuildOptions = {},
): NextRequest {
  const rawBody =
    opts.rawBody ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
  const secret = opts.secret ?? TEST_SECRET;
  const computed = computeSignature(secret, rawBody);
  const signature = opts.signature ?? computed;

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (!opts.omitSignature) {
    headers['x-signature'] = opts.withPrefix ? `sha256=${signature}` : signature;
  }

  const req = new Request(URL_STR, {
    method: 'POST',
    headers,
    body: rawBody,
  });
  return req as unknown as NextRequest;
}

/** Convenience: a minimally-valid webhook payload. */
function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Acme Lead',
    email: 'lead@example.com',
    phone: '+1 555 0100',
    source: 'fb ad',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Property 4 — HMAC verification is signature-correct
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — Property 4: HMAC bit-flip rejects', () => {
  /**
   * **Validates: Requirements 5.11**
   *
   * For an arbitrary body and an arbitrary single-character flip of the
   * canonical signature, the route MUST return 401. The bit-flip
   * arbitrary mutates one hex digit at a random index to a *different*
   * hex digit (skipped via `fc.pre` when the replacement equals the
   * original), guaranteeing the signature is no longer valid.
   *
   * The body content is irrelevant here: HMAC verification short-circuits
   * before JSON parsing, so we never touch the DB on a 401 — keeping
   * the property cheap to run hundreds of times.
   */
  it('any single-character flip of the valid signature yields 401', async () => {
    // ASCII payloads keep the UTF-8 encoding round-trip trivially predictable
    // and keep fast-check shrinkers focused on the signature index, not the
    // body bytes.
    const nameArb = fc
      .string({ minLength: 1, maxLength: 30 })
      .filter((s) => s.trim().length > 0)
      .map((s) => s.replace(/[^\x20-\x7e]/g, 'a'));
    const emailArb = fc
      .tuple(
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        fc.constantFrom('example.com', 'test.local', 'mail.io'),
      )
      .map(([prefix, domain]) => `${prefix}@${domain}`);
    const payloadArb = fc
      .record({ name: nameArb, email: emailArb })
      .map((p) => JSON.stringify(p));

    const idxArb = fc.integer({ min: 0, max: HEX_LEN - 1 });
    const replacementArb = fc.constantFrom(...HEX_DIGITS.split(''));

    await fc.assert(
      fc.asyncProperty(
        payloadArb,
        idxArb,
        replacementArb,
        async (rawBody, idx, replacement) => {
          const valid = computeSignature(TEST_SECRET, rawBody);
          const original = valid[idx]!;
          // Skip no-op flips — they would leave a valid signature behind
          // and the route would correctly accept it.
          fc.pre(original !== replacement);

          const flipped =
            valid.slice(0, idx) + replacement + valid.slice(idx + 1);
          const req = buildWebhookRequest(undefined, {
            rawBody,
            signature: flipped,
          });
          const res = await POST(req);
          expect(res.status).toBe(401);
        },
      ),
      // Integration-suite is single-fork; keep numRuns modest so the
      // property finishes well under the per-test timeout.
      { numRuns: 60 },
    );
  });
});

// ---------------------------------------------------------------------------
// Happy paths — valid signature with both header formats
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — happy path', () => {
  it('accepts a bare-hex signature, persists the Lead, and returns 201 + { id }', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    const payload = validPayload({
      name: 'Bare Hex Customer',
      email: 'bare-hex@example.com',
      phone: '+1 555 0001',
      source: 'fb ad',
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'spring-2026',
      tags: ['enterprise', 'inbound'],
      page: 'https://officepilot.example/contact',
    });
    const res = await POST(buildWebhookRequest(payload));

    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);
    expect(body).not.toBeNull();
    expect(typeof body!.id).toBe('string');
    expect(body!.id.length).toBeGreaterThan(0);

    const lead = await prisma.lead.findUnique({ where: { id: body!.id } });
    expect(lead).not.toBeNull();
    expect(lead!.name).toBe('Bare Hex Customer');
    expect(lead!.email).toBe('bare-hex@example.com');
    expect(lead!.createdById).toBe(admin.id);
  });

  it('accepts a `sha256=<hex>`-prefixed signature equally', async () => {
    await createTestUser({ role: 'ADMIN' });

    const payload = validPayload({
      name: 'Prefixed Customer',
      email: 'prefixed@example.com',
    });
    const res = await POST(
      buildWebhookRequest(payload, { withPrefix: true }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);
    expect(body).not.toBeNull();

    const count = await prisma.lead.count({
      where: { email: 'prefixed@example.com' },
    });
    expect(count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// HMAC failure modes
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — HMAC failures', () => {
  it('rejects a request with no x-signature header (401)', async () => {
    await createTestUser({ role: 'ADMIN' });

    const res = await POST(
      buildWebhookRequest(validPayload(), { omitSignature: true }),
    );

    expect(res.status).toBe(401);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('unauthorized');
    expect(await prisma.lead.count()).toBe(0);
  });

  it('rejects a request with an empty x-signature header (401)', async () => {
    await createTestUser({ role: 'ADMIN' });

    const res = await POST(
      buildWebhookRequest(validPayload(), { signature: '' }),
    );

    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('rejects a truncated (wrong-length) hex signature (401)', async () => {
    await createTestUser({ role: 'ADMIN' });

    const valid = computeSignature(TEST_SECRET, JSON.stringify(validPayload()));
    // Drop two hex chars to break the byte-length parity.
    const truncated = valid.slice(0, valid.length - 2);

    const res = await POST(
      buildWebhookRequest(validPayload(), { signature: truncated }),
    );

    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('rejects a non-hex signature even at the correct length (401)', async () => {
    await createTestUser({ role: 'ADMIN' });

    // 64 chars of `z` — same length as a SHA-256 hex digest, but every
    // character fails the HEX_RE sniffer in the route.
    const garbage = 'z'.repeat(HEX_LEN);

    const res = await POST(
      buildWebhookRequest(validPayload(), { signature: garbage }),
    );

    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });

  it('rejects a signature computed with the wrong secret (401)', async () => {
    await createTestUser({ role: 'ADMIN' });

    const res = await POST(
      buildWebhookRequest(validPayload(), { secret: 'definitely-not-the-secret' }),
    );

    expect(res.status).toBe(401);
    expect(await prisma.lead.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Server configuration failure modes
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — server configuration', () => {
  it('returns 500 when WEBHOOK_HMAC_SECRET is unset', async () => {
    await createTestUser({ role: 'ADMIN' });

    delete process.env.WEBHOOK_HMAC_SECRET;
    try {
      // Build the request *without* relying on the env secret — sign with
      // the literal we just removed so the body still parses correctly if
      // the route somehow gets past the secret check.
      const res = await POST(
        buildWebhookRequest(validPayload(), { secret: TEST_SECRET }),
      );

      expect(res.status).toBe(500);
      const body = await getJson<{ error: string }>(res);
      expect(body!.error).toBe('server_error');
      expect(await prisma.lead.count()).toBe(0);
    } finally {
      // afterEach also restores, but be explicit so subsequent assertions
      // in this same test (if any) see the canonical secret.
      process.env.WEBHOOK_HMAC_SECRET = TEST_SECRET;
    }
  });

  it('returns 500 when no ADMIN user exists', async () => {
    // Seed only an EMPLOYEE — beforeEach already truncated, so this is the
    // sole user.
    await createTestUser({ role: 'EMPLOYEE' });

    const res = await POST(buildWebhookRequest(validPayload()));

    expect(res.status).toBe(500);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('server_error');
    expect(await prisma.lead.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Body validation
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — body validation', () => {
  it('returns 400 when the body is not valid JSON (with a valid signature)', async () => {
    await createTestUser({ role: 'ADMIN' });

    const rawBody = 'not-json-at-all';
    const res = await POST(
      buildWebhookRequest(undefined, { rawBody }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.lead.count()).toBe(0);
  });

  it('returns 400 with an issues array when schema validation fails', async () => {
    await createTestUser({ role: 'ADMIN' });

    // Missing `name` AND missing both phone+email — two violations to
    // exercise the issues array.
    const payload = { source: 'website' };
    const res = await POST(buildWebhookRequest(payload));

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(body!.issues.length).toBeGreaterThan(0);
    expect(await prisma.lead.count()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Idempotency / dedupe within 24 hours
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — dedupe', () => {
  it('returns 200 + { deduplicated: true } on the second identical POST within 24h', async () => {
    await createTestUser({ role: 'ADMIN' });

    const payload = validPayload({
      name: 'Idempotent Customer',
      email: 'idempotent@example.com',
      phone: '+1 555 0202',
    });

    const first = await POST(buildWebhookRequest(payload));
    expect(first.status).toBe(201);
    const firstBody = await getJson<{ id: string }>(first);

    const second = await POST(buildWebhookRequest(payload));
    expect(second.status).toBe(200);
    const secondBody = await getJson<{ id: string; deduplicated: boolean }>(
      second,
    );
    expect(secondBody!.deduplicated).toBe(true);
    expect(secondBody!.id).toBe(firstBody!.id);

    expect(
      await prisma.lead.count({ where: { email: 'idempotent@example.com' } }),
    ).toBe(1);
  });

  it('does NOT dedupe when the matching lead is older than 24h', async () => {
    await createTestUser({ role: 'ADMIN' });

    const payload = validPayload({
      name: 'Recurring Customer',
      email: 'recurring@example.com',
      phone: '+1 555 0303',
    });

    const first = await POST(buildWebhookRequest(payload));
    expect(first.status).toBe(201);
    const firstBody = await getJson<{ id: string }>(first);

    // Backdate the existing lead so it's outside the 24h dedupe window.
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await prisma.lead.update({
      where: { id: firstBody!.id },
      data: { createdAt: longAgo },
    });

    const second = await POST(buildWebhookRequest(payload));
    expect(second.status).toBe(201);
    const secondBody = await getJson<{ id: string; deduplicated?: boolean }>(
      second,
    );
    expect(secondBody!.deduplicated).toBeUndefined();
    expect(secondBody!.id).not.toBe(firstBody!.id);

    expect(
      await prisma.lead.count({ where: { email: 'recurring@example.com' } }),
    ).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence + activity log
// ---------------------------------------------------------------------------

describe('POST /api/webhooks/leads — persistence + activity log', () => {
  it('persists source mapping, ownerId=null, oldest-admin createdById, UTM, and tags', async () => {
    // Two admins — the OLDER one (inserted first) must win as `createdById`.
    const { user: olderAdmin } = await createTestUser({
      role: 'ADMIN',
      name: 'Older Admin',
    });
    // Force a measurable createdAt gap so the orderBy `createdAt asc`
    // resolves deterministically even on fast machines.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await createTestUser({ role: 'ADMIN', name: 'Newer Admin' });

    const payload = validPayload({
      name: 'UTM Customer',
      email: 'utm@example.com',
      phone: '+1 555 0404',
      source: 'fb ad',
      utm_source: 'facebook',
      utm_medium: 'cpc',
      utm_campaign: 'q2-launch',
      tags: ['hot', 'enterprise', 'demo-requested'],
      page: 'https://officepilot.example/landing',
    });

    const res = await POST(buildWebhookRequest(payload));
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);

    const lead = await prisma.lead.findUnique({ where: { id: body!.id } });
    expect(lead).not.toBeNull();

    // Source coercion: "fb ad" → FACEBOOK_AD.
    expect(lead!.source).toBe(LeadSource.FACEBOOK_AD);
    // ownerId is null — admin can claim later from /leads.
    expect(lead!.ownerId).toBeNull();
    // createdById is the oldest admin.
    expect(lead!.createdById).toBe(olderAdmin.id);
    // UTM fields persist verbatim.
    expect(lead!.utmSource).toBe('facebook');
    expect(lead!.utmMedium).toBe('cpc');
    expect(lead!.utmCampaign).toBe('q2-launch');
    // Tags persist as an array (order preserved by Prisma's `String[]`).
    expect(lead!.tags).toEqual(['hot', 'enterprise', 'demo-requested']);
  });

  it('writes a `lead.webhook_received` activity log row with rich metadata', async () => {
    await createTestUser({ role: 'ADMIN' });

    const payload = validPayload({
      name: 'Audit Trail Customer',
      email: 'audit-trail@example.com',
      phone: '+1 555 0505',
      source: 'fb ad',
      page: 'https://officepilot.example/audit',
    });

    const res = await POST(buildWebhookRequest(payload));
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);

    const log = await prisma.activityLog.findFirst({
      where: {
        action: 'lead.webhook_received',
        entityType: 'lead',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.leadId).toBe(body!.id);

    // Metadata is `Json?` — narrow before reading.
    expect(log!.metadata).not.toBeNull();
    const metadata = log!.metadata as Record<string, unknown>;
    expect(metadata.entityName).toBe('Audit Trail Customer');
    expect(metadata.source).toBe(LeadSource.FACEBOOK_AD);
    expect(metadata.referringPage).toBe('https://officepilot.example/audit');
  });
});
