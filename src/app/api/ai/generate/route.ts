/**
 * `POST /api/ai/generate` — admin-only on-demand AI insight generation.
 *
 * SPEC.md §10.5 ("Routes/Pages/APIs"):
 *
 *   POST /api/ai/generate  → admin-only. Generate a fresh insight for
 *                            one of the four scopes ("ads", "social",
 *                            "leads", "overall") over a caller-supplied
 *                            window, persist it as an `AIInsight` row,
 *                            and return the row.
 *
 * The route is a thin wiring layer:
 *
 *   1. **Auth.** `requireAdminSession()` guarantees ADMIN; non-admins
 *      get a 403 (SPEC.md §10.5 "admin-only").
 *   2. **Validation.** `aiGenerateSchema` (Zod) enforces the body
 *      shape, including `periodStart < periodEnd`.
 *   3. **Generation.** All actual work — prev-window math, scope
 *      dispatch, trend computation, insufficient-data short-circuit,
 *      Claude call, persistence, best-effort audit log — lives in
 *      `generateScopeInsight(...)` (`src/lib/ai-insights.ts`). Sharing
 *      that helper with the daily-digest cron route (`/api/cron/
 *      daily-digest`, task 71) keeps the two surfaces in lock-step.
 *      We pass `userId: session.userId` so the on-demand path writes
 *      `ai.insight_generated` to `ActivityLog`.
 *   4. **Errors.** `errorResponse(...)` translates Zod, permission,
 *      and Prisma errors to the canonical JSON shape. Unknown errors
 *      come out as a generic 500 without leaking internals — see
 *      `src/lib/api-helpers.ts` for the full mapping.
 *
 * Implements task 66 of `.kiro/specs/officepilot/tasks.md`. The
 * `/api/ai/insights` list and the `/ai` admin page are tasks 67 and 70;
 * the cron entry point is task 71.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
} from '@/lib/api-helpers';
import { generateScopeInsight } from '@/lib/ai-insights';
import { aiGenerateSchema } from '@/lib/schemas/ai';

// Force the Node runtime — Prisma is not Edge-compatible, and the
// Anthropic SDK uses Node's `http` agent for streaming when available.
export const runtime = 'nodejs';

// Each request triggers a fresh Claude call; never serve a cached body.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// POST /api/ai/generate
// ---------------------------------------------------------------------------

/**
 * Generate one AI insight on demand and return the persisted row with
 * status 201.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const input = await parseJsonBody(req, aiGenerateSchema);
    const { scope, periodStart, periodEnd } = input;

    const insight = await generateScopeInsight({
      prisma,
      scope,
      periodStart,
      periodEnd,
      userId: session.userId,
    });

    return NextResponse.json(insight, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
