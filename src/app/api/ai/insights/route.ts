/**
 * `GET /api/ai/insights` — paginated list of AI insights (SPEC.md §10.5).
 *
 * Authorization
 * -------------
 * Per SPEC.md §2.1, EMPLOYEE has read access across all modules; the
 * only AI-specific gate is on cost / token-usage data ("cannot see AI
 * cost/usage settings"). So the list itself is open to any
 * authenticated session, but the per-row `tokenUsage` column is
 * stripped from the response unless the caller is ADMIN.
 *
 * Response shape (mirrors `/api/users` GET — task 26):
 *
 *   {
 *     items: AIInsight[],   // tokenUsage omitted for EMPLOYEE
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Sort order is `generatedAt DESC, id ASC` — newest first, with `id`
 * as the deterministic tiebreaker so paginated cursors don't shuffle
 * rows that were created in the same millisecond.
 *
 * Implements task 67 of `.kiro/specs/officepilot/tasks.md`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireSession,
} from '@/lib/api-helpers';
import { aiInsightListQuerySchema } from '@/lib/schemas/ai';

// Force the Node runtime — Prisma is not Edge-compatible. `force-dynamic`
// keeps Next from caching responses of an authenticated GET that varies
// by role (the projection differs for admins vs. employees).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Projection helpers
// ---------------------------------------------------------------------------

/**
 * Full `AIInsight` projection. Lists every persisted column (matches
 * `prisma/schema.prisma` exactly) so the typed select stays in lockstep
 * with the model definition.
 *
 * `tokenUsage` is included here for the ADMIN path; the EMPLOYEE
 * projection below is the same shape with that one key flipped to
 * `false`.
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

/**
 * Employee projection — identical to the admin projection except
 * `tokenUsage` is dropped (SPEC.md §2.1 — employees "cannot see AI
 * cost/usage settings"). Splatting the admin projection and overriding
 * the one key keeps the two projections trivially in sync if a future
 * column ships.
 */
const aiInsightEmployeeProjection = {
  ...aiInsightAdminProjection,
  tokenUsage: false,
} as const satisfies Prisma.AIInsightSelect;

// ---------------------------------------------------------------------------
// GET /api/ai/insights
// ---------------------------------------------------------------------------

/**
 * List AI insights with optional `scope` filter and standard
 * `page`/`pageSize` pagination. Any authenticated user.
 *
 * The query schema (`aiInsightListQuerySchema`) handles coercion and
 * defaults — `page=1`, `pageSize=50`.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireSession();

    const query = parseSearchParams(
      req.nextUrl.searchParams,
      aiInsightListQuerySchema,
    );

    // Build the Prisma `where` from whichever filters were supplied.
    // Each branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
    const where: Prisma.AIInsightWhereInput = {};
    if (query.scope !== undefined) {
      where.scope = query.scope;
    }

    // Pick the projection up-front so the row type matches the
    // response shape. Admins see `tokenUsage`; everyone else doesn't.
    const select =
      session.role === 'ADMIN'
        ? aiInsightAdminProjection
        : aiInsightEmployeeProjection;

    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them, so a single
    // round-trip via `Promise.all` is the right call.
    const [items, total] = await Promise.all([
      prisma.aIInsight.findMany({
        where,
        select,
        // Newest first; `id` ascending as a deterministic tiebreaker
        // for rows generated in the same millisecond (e.g. the daily
        // digest writes four scopes in one batch).
        orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take: query.pageSize,
      }),
      prisma.aIInsight.count({ where }),
    ]);

    return NextResponse.json({
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
