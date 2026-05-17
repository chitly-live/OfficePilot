/**
 * `POST /api/cron/daily-digest` — bearer-token-protected cron endpoint
 * that generates the four daily AI insights (one per scope) over a
 * rolling 7-day window.
 *
 * SPEC.md §10.6 ("Cron jobs"):
 *
 *   POST /api/cron/daily-digest
 *     - Hits Anthropic 4× sequentially (ads, social, leads, overall).
 *     - System prompt cached → calls 2-4 reuse the cached prefix
 *       (SPEC.md §10.4).
 *     - On error: log to ActivityLog, retry once after 1 h.
 *
 * **Public endpoint, bearer-gated.** The middleware
 * (`src/middleware.ts`) excludes `/api/cron/*` from cookie-based auth
 * so a system cron call without a session can reach us. The bearer
 * check below is therefore the entire authorization story; getting it
 * wrong means anyone on the public internet can burn our Claude
 * tokens. We compare the supplied token against `CRON_SECRET` with
 * {@link crypto.timingSafeEqual} so a timing-side-channel attack
 * cannot inch toward the right value byte-by-byte.
 *
 * **Why we do it sequentially** (SPEC.md §10.4): the system prompt is
 * marked with `cache_control: { type: 'ephemeral' }` in
 * `src/lib/claude.ts`, which gives a 5-minute cache window. Calls 2-4
 * in the same handler reuse the cached prefix and drop input-token
 * cost. `Promise.all(...)` would fire all four requests simultaneously
 * and miss the cache on three of them.
 *
 * **Why we don't call `/api/ai/generate` over HTTP.** Both surfaces
 * share the same per-scope pipeline (`generateScopeInsight` in
 * `src/lib/ai-insights.ts`). Calling the route HTTP-style would
 * require minting an internal admin session and would also serialise
 * + reparse the request through Next's edge layer for no benefit.
 *
 * **Audit logging.** `generateScopeInsight` only writes
 * `ai.insight_generated` to `ActivityLog` when its caller passes a
 * `userId`. Cron has no acting user, so we deliberately omit it —
 * surfacing a synthetic "system" user would distort the dashboard's
 * "recent activity" feed. The four resulting `AIInsight` rows on the
 * `/ai` admin page are themselves the audit trail for the digest run.
 *
 * **Error handling.** Each scope is wrapped in its own try/catch so
 * one bad scope (e.g., Claude returning malformed JSON for a
 * particularly noisy week of data) doesn't tank the rest. Per-scope
 * errors are returned in the response `errors[]` array and logged via
 * `console.error`. The retry-after-1h policy from SPEC.md §10.6 is
 * implemented by the cron worker (task 73), which inspects the
 * response and reschedules itself; this route is intentionally
 * stateless.
 *
 * **Response shape.**
 *
 *     {
 *       ok: true,
 *       generated: ["clx...", "clx...", ...],     // insight IDs in scope order
 *       errors: [{ scope: "ads", message: "..." }] // empty on full success
 *     }
 *
 * Status is always 200 on a happy authenticated request — partial
 * failures are surfaced in `errors[]`, not via HTTP status, so the
 * scheduler can record per-scope outcomes. Auth and infra failures
 * still produce 401 / 500 the usual way.
 *
 * Implements task 71 of `.kiro/specs/officepilot/tasks.md`.
 */

import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { errorResponse } from '@/lib/api-helpers';
import { generateScopeInsight } from '@/lib/ai-insights';
import type { AIScope } from '@/lib/schemas/ai';

// Force the Node runtime — Prisma + node:crypto + the Anthropic SDK
// are not Edge-compatible.
export const runtime = 'nodejs';

// Each request must execute live; never serve a cached response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Scopes processed by the daily digest, in the order the SDK is called.
 *
 * Order is significant because the system prompt cache is keyed on the
 * exact prompt prefix; the very first call writes the cache and the
 * rest read from it. Within that constraint the order is otherwise
 * arbitrary — we lock it down here so the response `generated[]` array
 * has a stable, documented ordering for downstream tooling.
 */
const DIGEST_SCOPES: readonly AIScope[] = [
  'ads',
  'social',
  'leads',
  'overall',
] as const;

/** Length of the analysis window (SPEC.md §10.4 — "previous 7 days"). */
const WINDOW_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Bearer token helpers
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from an `Authorization` header.
 *
 *   "Bearer abc123"  → "abc123"
 *   "bearer abc123"  → "abc123"
 *   anything else    → null
 *
 * Whitespace is trimmed; the scheme prefix is matched case-insensitively
 * (RFC 7235 allows `bearer` in any case, even though the canonical
 * spelling is `Bearer`).
 */
function extractBearerToken(rawHeader: string | null): string | null {
  if (rawHeader === null) return null;
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx < 0) return null;
  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== 'bearer') return null;
  const token = trimmed.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` requires equal-length buffers; an unequal length
 * is itself "trivially wrong" with no secret to leak by short-circuiting,
 * so we early-return `false` and skip the syscall.
 */
function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

/**
 * Per-scope failure entry returned in the response `errors[]` array.
 *
 *   - `scope`   — the failing scope (one of {@link DIGEST_SCOPES}).
 *   - `message` — short human-readable reason. Comes from the thrown
 *                 `Error.message` when available; never the raw stack
 *                 (the `console.error` call below carries that).
 */
interface DigestError {
  scope: AIScope;
  message: string;
}

// ---------------------------------------------------------------------------
// POST /api/cron/daily-digest
// ---------------------------------------------------------------------------

/**
 * Cron entry point. Sequentially generates one insight per scope over
 * a rolling 7-day window, returning the persisted insight IDs and any
 * per-scope errors.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // -- 1. Resolve and validate the bearer token. -------------------------
    //
    // `CRON_SECRET` is required: without one we can't verify anyone, so
    // the safe default is a hard 500 (loud failure, easy to spot in
    // monitoring) rather than silently accepting all callers.
    const expected = process.env.CRON_SECRET;
    if (expected === undefined || expected.length === 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[api/cron/daily-digest] CRON_SECRET not configured',
      );
      return NextResponse.json(
        { error: 'server_error', message: 'Cron secret not configured' },
        { status: 500 },
      );
    }

    const provided = extractBearerToken(req.headers.get('authorization'));
    if (provided === null || !safeStringEqual(provided, expected)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
    }

    // -- 2. Compute the rolling 7-day window. ------------------------------
    //
    // `periodEnd` is `now`; `periodStart` is exactly 7 days earlier.
    // `generateScopeInsight` derives the same-duration previous window
    // (the 7 days immediately before `periodStart`) internally.
    const periodEnd = new Date();
    const periodStart = new Date(
      periodEnd.getTime() - WINDOW_DAYS * MS_PER_DAY,
    );

    // -- 3. Run scopes sequentially so the system-prompt cache hits. -------
    //
    // We deliberately do NOT use `Promise.all` here; firing four
    // simultaneous requests would miss the 5-minute cache window on
    // three of them and triple our input-token bill (SPEC.md §10.4).
    //
    // Per SPEC.md §10.6, "On error: log to ActivityLog, retry once
    // after 1 h" — the retry-after-1h side is the cron worker's
    // responsibility (task 73). For this route we log the error and
    // continue with the remaining scopes so a single bad scope doesn't
    // tank the rest of the digest.
    const generated: string[] = [];
    const errors: DigestError[] = [];

    for (const scope of DIGEST_SCOPES) {
      try {
        const insight = await generateScopeInsight({
          prisma,
          scope,
          periodStart,
          periodEnd,
          // No acting user for cron — `generateScopeInsight` skips the
          // `ai.insight_generated` ActivityLog write when `userId` is
          // undefined. The four AIInsight rows themselves serve as
          // the audit trail for this run.
          userId: undefined,
        });
        generated.push(insight.id);
      } catch (scopeErr) {
        const message =
          scopeErr instanceof Error ? scopeErr.message : 'unknown error';
        // eslint-disable-next-line no-console
        console.error(
          `[api/cron/daily-digest] scope "${scope}" failed:`,
          scopeErr,
        );
        errors.push({ scope, message });
      }
    }

    return NextResponse.json(
      { ok: true, generated, errors },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
