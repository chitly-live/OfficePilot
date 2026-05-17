/**
 * `POST /api/webhooks/leads` — public, HMAC-verified inbound lead capture.
 *
 * SPEC.md §6.2 (feature 7 "Source attribution auto-fill from UTM params"
 * + feature 8 "Webhook endpoint for external form integrations") and
 * §6.3 (`POST /api/webhooks/leads → public webhook (HMAC verified)`).
 *
 * **Public route.** The middleware (`src/middleware.ts`) explicitly
 * lets `/api/webhooks/*` through without a session cookie. This route
 * is the ONLY thing standing between the public internet and the
 * `Lead` table, so the HMAC check below is the entire authorization
 * story — get it wrong and the table is open for spam.
 *
 * **HMAC scheme (SPEC.md §6.2 #8).**
 *
 *   1. The third-party form sends the raw JSON body it intends to POST
 *      and signs it with HMAC-SHA256 keyed on the shared
 *      `WEBHOOK_HMAC_SECRET`.
 *   2. The signature ships in the `x-signature` request header. Two
 *      formats are accepted:
 *
 *        x-signature: sha256=<hex>     // canonical (matches GitHub's
 *                                      // X-Hub-Signature-256 convention)
 *        x-signature: <hex>            // bare hex, for terser clients
 *
 *      Comparison is case-insensitive on the hex digits.
 *   3. We MUST recompute the HMAC over the *exact bytes* the client
 *      signed. `req.text()` returns the body verbatim — so we read it
 *      first, verify, then `JSON.parse` on the same string. Calling
 *      `req.json()` would give Next.js a chance to re-serialise (whitespace,
 *      key ordering, etc.) and break the signature.
 *   4. The hex comparison uses {@link crypto.timingSafeEqual} so a
 *      timing-side-channel attack can't inch toward the right
 *      signature byte-by-byte. Both buffers must be the same length;
 *      a length mismatch short-circuits to "invalid".
 *
 * **Status mapping.**
 *
 *   • `WEBHOOK_HMAC_SECRET` missing or empty       → 500
 *     (refuse to open the endpoint without a secret — silently
 *     accepting traffic would be worse than a hard fail).
 *   • `x-signature` header missing or unparseable  → 401
 *   • HMAC mismatch                                → 401
 *   • Body is not valid JSON                       → 400
 *   • Body fails `leadWebhookSchema`               → 400
 *   • No ADMIN user exists in the system           → 500
 *     (we need a `createdById` for the row; the seed creates one,
 *     so this only fires on a misconfigured deploy).
 *   • Existing matching lead in the last 24h       → 200 `{ id, deduplicated: true }`
 *   • Successful create                            → 201 `{ id }`
 *
 * **Idempotency.** Third-party forms often retry on transient errors,
 * so the same submission can arrive twice within seconds. We dedupe
 * on email or phone over the last 24 hours: any existing `Lead` whose
 * email matches OR whose phone matches (one is sufficient) wins, and
 * we return its id with `deduplicated: true`. The schema already
 * lower-cases email, so the email match is a straight equality.
 * Phones are matched on the raw stored string — a different format
 * sneaks through, which is acceptable for a 24h dedupe window.
 *
 * **Authorship.** Inbound webhooks have no session, but `Lead.createdById`
 * is non-nullable (SPEC.md §3 — `createdBy User @relation`). We attribute
 * the row to the oldest ADMIN user (orderBy `createdAt` asc) — the seed
 * admin (SPEC.md §2.3) is always present. `ownerId` is left `null` so
 * an admin can claim or assign the lead from `/leads`.
 *
 * **Activity log.** A best-effort `LEAD_WEBHOOK_RECEIVED` row is written
 * after a successful create with `{ entityName, source, referringPage }`
 * metadata. Logging failures are swallowed — the lead row is the
 * source of truth, and a missing audit row never tanks an otherwise
 * successful capture (SPEC.md §14).
 */

import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { leadWebhookSchema } from '@/lib/schemas/leads';

// Force the Node runtime — Prisma + node:crypto are not Edge-compatible.
export const runtime = 'nodejs';

// Each request must be re-evaluated against the live secret + DB.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Idempotency window for matching prior webhook captures. */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Hex-only sniffer — used to validate signature shape before we hand
 *  it to `Buffer.from(..., 'hex')`. `Buffer.from` silently drops
 *  invalid bytes, which would let a malformed signature slip through
 *  the length check; we reject explicitly here instead. */
const HEX_RE = /^[0-9a-fA-F]+$/;

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function unauthorized(message = 'Unauthorized'): NextResponse {
  return NextResponse.json({ error: 'unauthorized', message }, { status: 401 });
}

function badRequest(message: string, extras?: Record<string, unknown>): NextResponse {
  return NextResponse.json(
    { error: 'bad_request', message, ...(extras ?? {}) },
    { status: 400 },
  );
}

function serverError(message: string): NextResponse {
  return NextResponse.json({ error: 'server_error', message }, { status: 500 });
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/**
 * Extract the hex digest from an `x-signature` header.
 *
 *   "sha256=abcdef…"  → "abcdef…"
 *   "abcdef…"          → "abcdef…"
 *
 * Whitespace is trimmed; the `sha256=` prefix is matched case-insensitively
 * (some senders title-case it). Returns `null` when the header is missing
 * or empty after trimming.
 */
function extractSignatureHex(rawHeader: string | null): string | null {
  if (rawHeader === null) return null;
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) return null;
  // Strip an optional `sha256=` (or `SHA256=`) prefix.
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx >= 0 && trimmed.slice(0, eqIdx).toLowerCase() === 'sha256') {
    return trimmed.slice(eqIdx + 1).trim();
  }
  return trimmed;
}

/**
 * Constant-time hex comparison.
 *
 * `timingSafeEqual` requires equal-length buffers; an early length
 * check is a deliberate choice — a wrong-length signature is trivially
 * wrong and there's no secret to leak by short-circuiting on it.
 */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  if (!HEX_RE.test(a) || !HEX_RE.test(b)) return false;
  const aBuf = Buffer.from(a.toLowerCase(), 'hex');
  const bBuf = Buffer.from(b.toLowerCase(), 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// POST /api/webhooks/leads
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  // -- 1. Resolve the shared secret. ----------------------------------------
  //
  // We refuse to operate without one: an unset secret would mean any
  // signature we accept is meaningless, which is strictly worse than a
  // hard 500 (loud failure, easy to spot in monitoring).
  const secret = process.env.WEBHOOK_HMAC_SECRET;
  if (!secret || secret.length === 0) {
    // eslint-disable-next-line no-console
    console.error('[api/webhooks/leads] WEBHOOK_HMAC_SECRET is not configured');
    return serverError('Webhook secret not configured');
  }

  // -- 2. Read the raw body (verbatim bytes the client signed). -------------
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return badRequest('Unable to read request body');
  }

  // -- 3. Verify the HMAC signature. ----------------------------------------
  //
  // Header lookup is case-insensitive in `Headers.get`, so a single
  // call covers both `x-signature` and `X-Signature`.
  const sigHeader = req.headers.get('x-signature');
  const providedHex = extractSignatureHex(sigHeader);
  if (!providedHex) {
    return unauthorized('Missing signature');
  }

  const expectedHex = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('hex');

  if (!safeHexEqual(providedHex, expectedHex)) {
    return unauthorized('Invalid signature');
  }

  // -- 4. Parse + validate the JSON payload. --------------------------------
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return badRequest('Invalid JSON body');
  }

  const validated = leadWebhookSchema.safeParse(parsedJson);
  if (!validated.success) {
    return badRequest('Validation failed', { issues: validated.error.issues });
  }
  const data = validated.data;

  // -- 5. Idempotency: dedupe on email/phone within the last 24 h. ----------
  //
  // Either field is sufficient; the schema guarantees at least one is
  // present. Empty arrays would yield `email IN ()` which Postgres
  // rejects, so we conditionally append the OR branches.
  const dedupeSince = new Date(Date.now() - DEDUPE_WINDOW_MS);
  const dedupeOr: { email?: string; phone?: string }[] = [];
  if (data.email !== undefined) dedupeOr.push({ email: data.email });
  if (data.phone !== undefined) dedupeOr.push({ phone: data.phone });

  if (dedupeOr.length > 0) {
    const existing = await prisma.lead.findFirst({
      where: {
        createdAt: { gte: dedupeSince },
        OR: dedupeOr,
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { id: existing.id, deduplicated: true },
        { status: 200 },
      );
    }
  }

  // -- 6. Resolve the system "webhook" creator (oldest ADMIN). --------------
  //
  // `Lead.createdById` is non-nullable (SPEC.md §3). The seed user
  // (SPEC.md §2.3) is always the oldest admin on a freshly-deployed
  // instance, so this picks a stable owner. If somehow no admin
  // exists, we refuse to fabricate the row — better to surface a 500
  // and have an operator fix the deploy.
  const systemCreator = await prisma.user.findFirst({
    where: { role: 'ADMIN' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });

  if (!systemCreator) {
    // eslint-disable-next-line no-console
    console.error(
      '[api/webhooks/leads] no ADMIN user found to attribute webhook lead',
    );
    return serverError('No admin user available to record webhook lead');
  }

  // -- 7. Persist the lead. -------------------------------------------------
  const created = await prisma.lead.create({
    data: {
      name: data.name,
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
      ...(data.email !== undefined ? { email: data.email } : {}),
      ...(data.company !== undefined ? { company: data.company } : {}),
      ...(data.city !== undefined ? { city: data.city } : {}),
      source: data.source,
      ...(data.notes !== undefined ? { notes: data.notes } : {}),
      tags: data.tags,
      ...(data.utmSource !== undefined ? { utmSource: data.utmSource } : {}),
      ...(data.utmMedium !== undefined ? { utmMedium: data.utmMedium } : {}),
      ...(data.utmCampaign !== undefined ? { utmCampaign: data.utmCampaign } : {}),
      // v0.1.4 — Chitly-spreadsheet fields. The webhook schema's
      // `transform` already provides camelCase aliases (`activeSince`,
      // `phoneType`, `notOnWhatsapp` etc.). Defaults
      // (`languages: []`, `notOnWhatsapp: false`) mirror the Prisma
      // column defaults so an omitted field round-trips identically
      // whether the lead arrives via this webhook or `POST /api/leads`.
      ...(data.age !== undefined ? { age: data.age } : {}),
      ...(data.activeSince !== undefined ? { activeSince: data.activeSince } : {}),
      languages: data.languages,
      ...(data.extraDetails !== undefined ? { extraDetails: data.extraDetails } : {}),
      ...(data.phoneType !== undefined ? { phoneType: data.phoneType } : {}),
      notOnWhatsapp: data.notOnWhatsapp,
      ...(data.address !== undefined ? { address: data.address } : {}),
      createdById: systemCreator.id,
      // Owner is left null — an admin can claim/assign from /leads.
      ownerId: null,
    },
    select: { id: true },
  });

  // -- 8. Best-effort activity log. ----------------------------------------
  //
  // Carries the human-friendly `entityName` (so the formatter doesn't
  // fall back to "lead {id}"), the resolved `source`, and the referring
  // page URL when available — useful when triaging which embed produced
  // a given lead.
  try {
    await logActivity(prisma, {
      userId: systemCreator.id,
      action: ACTIVITY_ACTIONS.LEAD_WEBHOOK_RECEIVED,
      entityType: 'lead',
      entityId: created.id,
      leadId: created.id,
      metadata: {
        entityName: data.name,
        source: data.source,
        ...(data.referringPage !== undefined
          ? { referringPage: data.referringPage }
          : {}),
      },
    });
  } catch (logErr) {
    // eslint-disable-next-line no-console
    console.error('[api/webhooks/leads] activity log failed', logErr);
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}
