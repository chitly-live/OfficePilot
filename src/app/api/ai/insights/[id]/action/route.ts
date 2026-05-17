/**
 * `POST /api/ai/insights/[id]/action` — mark an AI insight as actioned
 * (SPEC.md §10.5, feature §10.2 #5 "Suggestion follow-up").
 *
 * Authorization: ADMIN-only. Per SPEC.md §2.1, deciding to act on an
 * AI suggestion is an admin-level call (the insight feed is read-only
 * for employees). The middleware already gates `/api/*` for
 * authenticated traffic, but the handler also calls
 * `requireAdminSession()` defensively so a misconfigured matcher can't
 * accidentally expose the action endpoint to employees.
 *
 * Body
 * ----
 * Optional `{ note?: string }`. We store the note alongside the scope
 * in the activity-log metadata so the audit trail explains *why* an
 * admin actioned this insight (e.g. "boosted Reels budget +20%").
 * The note is trimmed and length-capped to keep ActivityLog rows
 * reasonable.
 *
 * Side effects
 * ------------
 * One `ai.insight_actioned` row goes to `ActivityLog` with
 * `entityType='ai_insight'` and `entityId={id}`. The `metadata` field
 * carries `{ scope: insight.scope, note? }` so feed renderers can show
 * the affected scope without re-querying. Audit logging is best-effort
 * (try/catch) — a missing log row never tanks the action call
 * (SPEC.md §14).
 *
 * Response
 * --------
 * `{ ok: true, insightId: id }` with status 200 on success.
 *
 * Implements task 67 of `.kiro/specs/officepilot/tasks.md`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Generous upper bound on the optional note. Long enough for a
 * paragraph of context, short enough that an accidental paste-bomb
 * hits Zod (and a 400) instead of bloating ActivityLog metadata.
 */
const MAX_NOTE_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

/**
 * Request body schema. Inline (rather than added to
 * `src/lib/schemas/ai.ts`) because nothing else in the app validates
 * this shape — the action panel on `/ai/[id]` is the sole client.
 *
 * `note` is trimmed and only kept when non-empty so a `{ note: ' ' }`
 * payload doesn't pollute the audit log with whitespace.
 */
const actionBodySchema = z.object({
  note: z
    .string()
    .trim()
    .max(MAX_NOTE_LENGTH, `Note must be ${MAX_NOTE_LENGTH} characters or fewer`)
    .optional()
    .transform((val) => (val !== undefined && val.length === 0 ? undefined : val)),
});

// ---------------------------------------------------------------------------
// Route context
// ---------------------------------------------------------------------------

/**
 * Next.js 14 App Router dynamic-segment context for `[id]`.
 */
interface RouteContext {
  params: { id: string };
}

// ---------------------------------------------------------------------------
// POST /api/ai/insights/[id]/action
// ---------------------------------------------------------------------------

/**
 * Mark the insight as actioned. Admin-only. Returns 200 with
 * `{ ok: true, insightId }` on success.
 *
 * Flow:
 *   1. `requireAdminSession()` — 401 if no session, 403 if not ADMIN.
 *   2. Parse the (possibly empty) JSON body. Empty bodies are common
 *      because the UI's "Mark as actioned" button has no required
 *      input; we default the body to `{}` when the request carries no
 *      JSON so the schema's optional `note` works either way.
 *   3. `findUniqueOrThrow` on the insight so a missing id flows
 *      through `errorResponse`'s P2025 → 404 mapping.
 *   4. Best-effort `ai.insight_actioned` row to `ActivityLog`.
 *   5. Return `{ ok: true, insightId: id }`.
 */
export async function POST(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    // The "Mark as actioned" button may post with no body. Treat an
    // empty / unparseable body as `{}` so the optional-only schema
    // accepts it; non-empty bodies must still be valid JSON. We do
    // this BEFORE schema validation so a 400 still fires for
    // malformed-but-non-empty payloads (e.g. `{ note: 12345 }`).
    let rawBody: unknown = {};
    const contentLength = req.headers.get('content-length');
    if (contentLength !== '0' && contentLength !== null) {
      try {
        rawBody = await req.json();
      } catch {
        // Empty body or whitespace-only body — treat as `{}`. Any
        // structural issue with non-empty JSON would have surfaced
        // here too; the schema below catches the rest.
        rawBody = {};
      }
    }
    const parsed = actionBodySchema.safeParse(rawBody);
    if (!parsed.success) {
      // Re-use the canonical bad-request mapping via BadRequestError so
      // the response shape matches `parseJsonBody`'s 400 path
      // (`{ error: 'bad_request', issues: [...] }`).
      throw new BadRequestError('Validation failed', parsed.error);
    }
    const { note } = parsed.data;

    // 404-on-missing flows through P2025 in errorResponse. We need
    // the row anyway to read `scope` for the audit metadata.
    const insight = await prisma.aIInsight.findUniqueOrThrow({
      where: { id },
      select: { id: true, scope: true },
    });

    // Best-effort audit log. `logActivity` propagates errors by
    // design (see `src/lib/activity.ts`); the try/catch here keeps
    // the route's happy path resilient to a missing audit row
    // (SPEC.md §14 — "audit log writes are best-effort").
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.AI_INSIGHT_ACTIONED,
        entityType: 'ai_insight',
        entityId: insight.id,
        // Splat `note` only when present so the JSON column doesn't
        // carry an explicit `note: undefined` (Prisma writes `null`
        // for that, which would muddle "no note" with "null note").
        metadata: {
          scope: insight.scope,
          ...(note !== undefined ? { note } : {}),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/ai/insights/[id]/action] activity log failed', logErr);
    }

    return NextResponse.json({ ok: true, insightId: insight.id });
  } catch (err) {
    return errorResponse(err);
  }
}
