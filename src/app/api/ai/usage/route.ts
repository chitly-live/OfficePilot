/**
 * `GET /api/ai/usage` — admin-only AI token usage + Claude cost
 * estimation (SPEC.md §10.5, §10.6).
 *
 * Authorization
 * -------------
 * Admin-only. Per SPEC.md §2.1 ("EMPLOYEE … cannot see AI cost/usage
 * settings"), employees never see token / cost figures, so the route
 * 403s any non-ADMIN session via {@link requireAdminSession}.
 *
 * Query parameters
 * ----------------
 *   • `period` — one of `'7d' | '30d' | '90d' | 'all'`. Defaults to
 *     `'30d'`. Anything else is rejected with a 400 by Zod.
 *
 * Aggregations
 * ------------
 * Pulled from the `AIInsight` table (each row carries an `Int?`
 * `tokenUsage`). Treats a `null` `tokenUsage` as 0 — the column is
 * nullable because the "Insufficient data" short-circuit in
 * `POST /api/ai/generate` (task 66) skips the Claude call entirely
 * and writes the row with no tokens consumed.
 *
 *   • `totalTokens`   — sum of `tokenUsage` over the window.
 *   • `totalInsights` — count of `AIInsight` rows in the window.
 *   • `byScope`       — one row per distinct `scope` value seen in the
 *                        window: `{ scope, tokens, insights }`.
 *   • `byDay`         — one row per UTC date that had at least one
 *                        insight: `{ date: 'YYYY-MM-DD', tokens,
 *                        insights }`. Sorted ascending by date so the
 *                        chart renders left-to-right.
 *
 * Cost estimation
 * ---------------
 * Claude Sonnet 4.6 lists at $3 / M input tokens and $15 / M output
 * tokens (SPEC.md §10.6 Notes — "monthly Claude spend estimate"). The
 * `AIInsight.tokenUsage` column is a single blended `Int` — we do
 * **not** persist input/output token splits per insight — so this
 * route reports a midpoint estimate that assumes a 50/50 split:
 *
 *     estimatedUsdCost = totalTokens / 1_000_000
 *                      * ((COST_PER_MTOK_INPUT + COST_PER_MTOK_OUTPUT) / 2)
 *
 * Rounded to 2 decimals. The `costNote` field in the response makes
 * the assumption explicit so the UI can disclose it next to the
 * dollar figure.
 *
 * Response
 * --------
 *
 *   {
 *     period:           '7d' | '30d' | '90d' | 'all',
 *     periodStart:      ISO string | null,   // null when period === 'all'
 *     periodEnd:        ISO string,          // request time
 *     totalTokens:      number,
 *     totalInsights:    number,
 *     estimatedUsdCost: number,              // 2-decimal rounded
 *     costNote:         string,
 *     byScope:          { scope: string; tokens: number; insights: number }[],
 *     byDay:            { date: string; tokens: number; insights: number }[]
 *   }
 *
 * Implements task 68 of `.kiro/specs/officepilot/tasks.md`.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';

// Force the Node runtime — Prisma is not Edge-compatible. `force-dynamic`
// keeps Next from caching responses of an authenticated GET that varies
// by the moving "now" reference used to compute `periodStart`.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Pricing constants
// ---------------------------------------------------------------------------

/**
 * USD per 1M input tokens for `claude-sonnet-4-6` (SPEC.md §10.6).
 * Kept inline rather than env-driven because the Anthropic price list
 * is part of the route's documented behaviour — bumping the rate
 * should be a deliberate code change, not a runtime config flip.
 */
const COST_PER_MTOK_INPUT = 3;

/** USD per 1M output tokens for `claude-sonnet-4-6`. */
const COST_PER_MTOK_OUTPUT = 15;

/**
 * Disclosure copy returned alongside `estimatedUsdCost`. Mirrors the
 * 50/50 assumption documented in this file's header so the UI can
 * surface the caveat without re-deriving it.
 */
const COST_NOTE =
  'Blended estimate; assumes 50/50 input/output token split';

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Inline query schema. The four allowed `period` values map to:
 *   • `'7d'`  →  now − 7 days
 *   • `'30d'` →  now − 30 days  (default — matches SPEC.md §7.2.6 and
 *                                §10.5 "monthly" framing closely enough
 *                                for a usage rollup)
 *   • `'90d'` →  now − 90 days
 *   • `'all'` →  no lower bound (reports lifetime token usage)
 */
const aiUsageQuerySchema = z.object({
  period: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
});

type AIUsagePeriod = z.infer<typeof aiUsageQuerySchema>['period'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the inclusive lower bound of the window for the given
 * `period`. `'all'` returns `null` (no lower bound — every persisted
 * insight is included).
 *
 * `now` is taken as a parameter so the calculation stays pure and we
 * don't risk drift between "now" used for the bound and "now"
 * reported in `periodEnd`.
 */
function periodToFrom(period: AIUsagePeriod, now: Date): Date | null {
  if (period === 'all') return null;
  const days = period === '7d' ? 7 : period === '30d' ? 30 : 90;
  // Subtract `days * 86_400_000` ms from `now`. Using millis instead of
  // calendar arithmetic keeps the bound stable across DST transitions —
  // we want a rolling 30 × 24 h window, not "30 calendar days".
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// GET /api/ai/usage
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();

    const { period } = parseSearchParams(
      req.nextUrl.searchParams,
      aiUsageQuerySchema,
    );

    // Capture "now" once so `periodStart` / `periodEnd` agree. The
    // window is `[from, now]` inclusive on both ends; `from === null`
    // for `period === 'all'`.
    const now = new Date();
    const from = periodToFrom(period, now);

    // Build the shared `where` once — every query in this handler
    // uses the same filter so the four numbers stay consistent.
    const where: Prisma.AIInsightWhereInput = from
      ? { generatedAt: { gte: from, lte: now } }
      : {};

    // Three independent aggregations + one row fetch — fan out via
    // `Promise.all` so the route stays in a single round-trip's worth
    // of latency.
    //
    //   1. `aggregate` for headline `totalTokens` and `totalInsights`.
    //   2. `groupBy` on `scope` for the per-scope rollup.
    //   3. `findMany` projecting `(generatedAt, tokenUsage)` so we can
    //      bucket by ISO date in JS — Prisma's `groupBy` doesn't
    //      support `date_trunc`-style expressions on a `DateTime`
    //      column without raw SQL.
    const [headline, byScopeRows, dayRows] = await Promise.all([
      prisma.aIInsight.aggregate({
        where,
        _sum: { tokenUsage: true },
        _count: { _all: true },
      }),
      prisma.aIInsight.groupBy({
        by: ['scope'],
        where,
        _sum: { tokenUsage: true },
        _count: { _all: true },
      }),
      prisma.aIInsight.findMany({
        where,
        select: { generatedAt: true, tokenUsage: true },
      }),
    ]);

    // `tokenUsage` is `Int?` — Prisma returns `null` for an empty
    // window or when every row in the window has `null` tokens (e.g.
    // only "Insufficient data" insights). Coerce to 0 so the response
    // is always a number.
    const totalTokens = headline._sum.tokenUsage ?? 0;
    const totalInsights = headline._count._all;

    // 50/50 blended rate × tokens / 1M, rounded to cents. We round at
    // the response boundary only — internal math stays in floats so a
    // future split-aware estimator can drop in without re-rounding.
    const blendedRatePerMTok =
      (COST_PER_MTOK_INPUT + COST_PER_MTOK_OUTPUT) / 2;
    const rawCost = (totalTokens / 1_000_000) * blendedRatePerMTok;
    const estimatedUsdCost = Math.round(rawCost * 100) / 100;

    // Per-scope rollup. Coerce the nullable `_sum.tokenUsage` to 0 so
    // the response is uniform across scopes that only ever produced
    // "Insufficient data" insights.
    const byScope = byScopeRows
      .map((row) => ({
        scope: row.scope,
        tokens: row._sum.tokenUsage ?? 0,
        insights: row._count._all,
      }))
      // Stable alphabetic order so the chart legend doesn't reshuffle
      // between calls.
      .sort((a, b) => a.scope.localeCompare(b.scope));

    // Bucket by ISO date prefix (`YYYY-MM-DD`) of `generatedAt`. Using
    // `toISOString().slice(0, 10)` keeps the buckets in UTC; that's
    // the same convention the rest of the API uses for date keys
    // (e.g. campaign rollups) so the frontend chart libraries can
    // share one date axis.
    const dayBuckets = new Map<string, { tokens: number; insights: number }>();
    for (const row of dayRows) {
      const date = row.generatedAt.toISOString().slice(0, 10);
      let bucket = dayBuckets.get(date);
      if (!bucket) {
        bucket = { tokens: 0, insights: 0 };
        dayBuckets.set(date, bucket);
      }
      bucket.tokens += row.tokenUsage ?? 0;
      bucket.insights += 1;
    }

    const byDay = Array.from(dayBuckets.entries())
      .map(([date, b]) => ({ date, tokens: b.tokens, insights: b.insights }))
      // Ascending by date — chart renders left → right, oldest first.
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      period,
      periodStart: from ? from.toISOString() : null,
      periodEnd: now.toISOString(),
      totalTokens,
      totalInsights,
      estimatedUsdCost,
      costNote: COST_NOTE,
      byScope,
      byDay,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
