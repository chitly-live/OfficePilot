/**
 * `GET /api/ai/insights/[id]` — full detail for one AI insight
 * (SPEC.md §10.5).
 *
 * Authorization mirrors the list endpoint (`GET /api/ai/insights`):
 * any authenticated user can read, but the `tokenUsage` column is
 * stripped from the response for non-admins per SPEC.md §2.1
 * ("EMPLOYEE … cannot see AI cost/usage settings"). The detail page
 * (`/ai/[id]`, task 70) renders the raw aggregation snapshot, so this
 * route returns the full row including `rawData`.
 *
 * 404 handling: we use `findUniqueOrThrow` so a missing row raises
 * Prisma's `P2025`, which `errorResponse(...)` translates to the
 * canonical `{ error: 'not_found' }` 404 shape used everywhere else
 * in the API (see `src/lib/api-helpers.ts`).
 *
 * Implements task 67 of `.kiro/specs/officepilot/tasks.md`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import { errorResponse, requireSession } from '@/lib/api-helpers';

// Force the Node runtime — Prisma is not Edge-compatible. `force-dynamic`
// disables caching of an authenticated GET whose body varies with role.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types & projections
// ---------------------------------------------------------------------------

/**
 * Next.js 14 App Router dynamic-segment context for `[id]`.
 */
interface RouteContext {
  params: { id: string };
}

/**
 * Full `AIInsight` projection — every column on the model. Admins get
 * this one. The employee projection below toggles `tokenUsage` off so
 * the cost data never crosses the API boundary for non-admins
 * (SPEC.md §2.1).
 */
const aiInsightAdminProjection = {
  id: true,
  generatedAt: true,
  periodStart: true,
  periodEnd: true,
  scope: true,
  trend: true,
  trendPct: true,
  summary: true,
  suggestion: true,
  rawData: true,
  tokenUsage: true,
} as const satisfies Prisma.AIInsightSelect;

/** Same as the admin projection minus `tokenUsage`. */
const aiInsightEmployeeProjection = {
  ...aiInsightAdminProjection,
  tokenUsage: false,
} as const satisfies Prisma.AIInsightSelect;

// ---------------------------------------------------------------------------
// GET /api/ai/insights/[id]
// ---------------------------------------------------------------------------

/**
 * Return one AI insight by id. Any authenticated user.
 *
 * Returns 404 (`{ error: 'not_found' }`) when no row matches — Prisma's
 * `P2025` from `findUniqueOrThrow` flows through `errorResponse(...)`
 * and produces the standard shape.
 */
export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    const select =
      session.role === 'ADMIN'
        ? aiInsightAdminProjection
        : aiInsightEmployeeProjection;

    // `findUniqueOrThrow` lets `errorResponse` map P2025 → 404 with
    // the canonical `{ error: 'not_found' }` body, matching the rest
    // of the API (see `src/app/api/users/[id]/route.ts` for the
    // equivalent pattern).
    const insight = await prisma.aIInsight.findUniqueOrThrow({
      where: { id },
      select,
    });

    return NextResponse.json(insight);
  } catch (err) {
    return errorResponse(err);
  }
}
