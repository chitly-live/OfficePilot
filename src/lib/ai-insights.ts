/**
 * Reusable AI insight generation pipeline (SPEC.md §10).
 *
 * The same per-scope sequence — aggregate metrics → compute trend in code
 * → short-circuit on insufficient data → call Claude → persist `AIInsight`
 * → best-effort audit log — is needed by two surfaces:
 *
 *   1. The admin-only on-demand route (`POST /api/ai/generate`) implemented
 *      in task 66. It runs inside an authenticated session so it has a
 *      `userId` to attribute the audit row to.
 *   2. The daily-digest cron route (`POST /api/cron/daily-digest`,
 *      task 71). It runs unauthenticated (bearer-token-protected) and has
 *      no acting user, so it skips the audit log.
 *
 * Rather than have the cron route call `/api/ai/generate` over HTTP — which
 * would require minting an internal admin session and would lose the
 * benefit of the cached SDK client between calls — both surfaces invoke
 * {@link generateScopeInsight} directly. The caller decides whether to run
 * one scope or four, sequentially or in parallel; this module owns the
 * single-scope contract.
 *
 * The function is intentionally Prisma-DI: it accepts any
 * `PrismaClient | Prisma.TransactionClient` so a future caller could batch
 * the four daily-digest writes inside a `prisma.$transaction(...)` if we
 * ever decide all-or-nothing semantics matter. Today, the cron route runs
 * each scope independently and continues past errors.
 *
 * Implements task 71's refactor (extracted from `src/app/api/ai/generate/
 * route.ts`).
 */

import type { AIInsight, PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';

import { generateInsight } from '@/lib/claude';
import { computeTrend, type TrendResult } from '@/lib/trend';
import { aggregateAds } from '@/lib/aggregations/ads';
import { aggregateSocial } from '@/lib/aggregations/social';
import { aggregateLeads } from '@/lib/aggregations/leads';
import { aggregateOverall } from '@/lib/aggregations/overall';
import { aggregatePredictions } from '@/lib/aggregations/predictions';
import { aggregateAnomalies } from '@/lib/aggregations/anomalies';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import type { AIScope } from '@/lib/schemas/ai';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Structural Prisma client accepted by {@link generateScopeInsight}.
 *
 * `PrismaClient` (the production singleton from `@/lib/db`) and
 * `Prisma.TransactionClient` (the inner client passed into
 * `prisma.$transaction(...)` callbacks) both satisfy this. Tests that use
 * a real Postgres database via `npm run test:int` can pass either.
 */
export type AIInsightDbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Arguments for {@link generateScopeInsight}.
 *
 *   • `prisma`      — DI'd Prisma client / transactional client.
 *   • `scope`       — which slice of the business to analyse (SPEC.md §10.3).
 *   • `periodStart` — inclusive lower bound of the analysis window.
 *   • `periodEnd`   — inclusive upper bound (must be strictly greater
 *                     than `periodStart`; the caller is responsible for
 *                     validation — see `aiGenerateSchema`).
 *   • `userId`      — optional acting user. When provided (the on-demand
 *                     route path), an `ai.insight_generated` row is
 *                     written to `ActivityLog` on a best-effort basis.
 *                     When omitted (the cron path), audit logging is
 *                     skipped — cron has no acting user, and surfacing
 *                     a synthetic system user would distort the
 *                     "recent activity" feed.
 */
export interface GenerateScopeInsightArgs {
  prisma: AIInsightDbClient;
  scope: AIScope;
  periodStart: Date;
  periodEnd: Date;
  userId?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Result of the scope-specific aggregation step. The raw aggregation
 * payload feeds Claude (and is persisted as `AIInsight.rawData`), while
 * the headline (`current`, `previous`) numeric pair feeds
 * `computeTrend(...)`.
 *
 * Headline metric per scope (SPEC.md §10.3):
 *   - `ads`     → `summary.totalSignups`     vs. `summary.totalSignupsPrev`
 *   - `social`  → `summary.totalReach`       vs. `summary.totalReachPrev`
 *   - `leads`   → `summary.newLeads`         vs. `summary.newLeadsPrev`
 *   - `overall` → `summary.leads.current`    vs. `summary.leads.previous`
 */
interface ScopeAggregation {
  rawData: unknown;
  current: number;
  previous: number;
}

// ---------------------------------------------------------------------------
// Aggregation dispatch
// ---------------------------------------------------------------------------

/**
 * Run the right aggregator for the requested scope and pull out the
 * headline (current, previous) pair used for trend computation.
 *
 * Each branch is fully type-checked because the aggregator return shapes
 * are concrete — adding a new scope here without first updating the
 * schema enum and aggregator surface is a TS error, not a runtime bug.
 */
async function runAggregation(
  prisma: AIInsightDbClient,
  scope: AIScope,
  periodStart: Date,
  periodEnd: Date,
  prevStart: Date,
  prevEnd: Date,
): Promise<ScopeAggregation> {
  switch (scope) {
    case 'ads': {
      const data = await aggregateAds(
        prisma,
        periodStart,
        periodEnd,
        prevStart,
        prevEnd,
      );
      return {
        rawData: data,
        current: data.summary.totalSignups,
        previous: data.summary.totalSignupsPrev,
      };
    }
    case 'social': {
      const data = await aggregateSocial(
        prisma,
        periodStart,
        periodEnd,
        prevStart,
        prevEnd,
      );
      return {
        rawData: data,
        current: data.summary.totalReach,
        previous: data.summary.totalReachPrev,
      };
    }
    case 'leads': {
      const data = await aggregateLeads(
        prisma,
        periodStart,
        periodEnd,
        prevStart,
        prevEnd,
      );
      return {
        rawData: data,
        current: data.summary.newLeads,
        previous: data.summary.newLeadsPrev,
      };
    }
    case 'overall': {
      const data = await aggregateOverall(
        prisma,
        periodStart,
        periodEnd,
        prevStart,
        prevEnd,
      );
      return {
        rawData: data,
        current: data.summary.leads.current,
        previous: data.summary.leads.previous,
      };
    }
    case 'predictions': {
      // Predictions aggregator uses a 28-day rolling window anchored at
      // `periodEnd`; the explicit `periodStart`/prev pair is unused here
      // because the forecast is inherently relative to a single "now".
      // Headline: 7-day forecasted spend vs the actual last-7-day spend
      // so `computeTrend` reports the forecast direction in INR terms.
      const data = await aggregatePredictions(prisma, { now: periodEnd });
      const last7Actual = data.spend.daily
        .slice(-7)
        .reduce((sum, p) => sum + p.value, 0);
      return {
        rawData: data,
        current: data.spend.next7DayProjection,
        previous: last7Actual,
      };
    }
    case 'anomalies': {
      // Anomaly aggregator compares today vs a 7-day baseline. There's no
      // "previous period" in the SPEC §10.3 sense; we map the headline
      // pair to anomaly-count-now vs 0 so `computeTrend` is `up` when any
      // anomalies fire and `flat` otherwise. Claude does the narration.
      const data = await aggregateAnomalies(prisma, { now: periodEnd });
      return {
        rawData: data,
        current: data.anomalies.length,
        previous: 0,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// generateScopeInsight
// ---------------------------------------------------------------------------

/**
 * Produce one persisted AI insight for a single scope.
 *
 * Pipeline (matches SPEC.md §10.2 features 1–4 and §10.7):
 *
 *   1. Compute the comparison window — same duration as the requested
 *      window, ending exactly 1 ms before `periodStart` so the two
 *      windows are non-overlapping under every aggregator's inclusive
 *      `gte/lte` filters.
 *   2. Run the scope's aggregator against `prisma` for both windows.
 *   3. Compute the numeric trend in code via `computeTrend(...)`. We
 *      always trust this value over whatever Claude returns for `trend`
 *      / `trendPct`; per SPEC.md §10.2 feature 3, "Trend detection:
 *      numeric trend computed in code; Claude generates the narrative
 *      and suggestion."
 *   4. If both current and previous headline metrics are zero, skip
 *      Claude entirely and persist an "Insufficient data" insight
 *      (SPEC.md §10.7 graceful degradation). This keeps token bills
 *      off when there is nothing meaningful to say.
 *   5. Otherwise call `generateInsight(...)` for the narrative +
 *      suggestion, override `trend` / `trendPct` with the local values,
 *      and record the actual token usage.
 *   6. Persist a fresh `AIInsight` row. `generatedAt` defaults to
 *      `now()` in Prisma so server-time semantics live in one place.
 *   7. If `userId` is provided, best-effort log
 *      `ai.insight_generated` to `ActivityLog`. Failures are swallowed
 *      so a missing audit row never tanks a successful insight write
 *      (SPEC.md §14 — "audit log writes are best-effort"). When
 *      `userId` is undefined (cron path), audit logging is skipped
 *      entirely — see the `GenerateScopeInsightArgs.userId` doc.
 *
 * Throws when the aggregation step, the Claude call (when invoked), or
 * the `AIInsight.create` write fails. Callers (the on-demand route, the
 * cron route) are responsible for translating those errors to HTTP
 * responses or per-scope error entries.
 *
 * @param args see {@link GenerateScopeInsightArgs}.
 * @returns the freshly persisted `AIInsight` row.
 */
export async function generateScopeInsight(
  args: GenerateScopeInsightArgs,
): Promise<AIInsight> {
  const { prisma, scope, periodStart, periodEnd, userId } = args;

  // 1. Same-duration previous window, ending 1 ms before `periodStart`.
  const durationMs = periodEnd.getTime() - periodStart.getTime();
  const prevEnd = new Date(periodStart.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - durationMs);

  // 2. Aggregate metrics for both windows.
  const aggregation = await runAggregation(
    prisma,
    scope,
    periodStart,
    periodEnd,
    prevStart,
    prevEnd,
  );

  // 3. Numeric trend, computed in code.
  const localTrend: TrendResult = computeTrend(
    aggregation.current,
    aggregation.previous,
  );

  // 4. Insufficient-data short-circuit.
  const isInsufficient =
    aggregation.current === 0 &&
    (aggregation.previous === 0 || aggregation.previous == null);

  let summary: string;
  let suggestion: string;
  let tokenUsage: number;

  if (isInsufficient) {
    summary = 'Insufficient data for this period';
    suggestion = 'Add more activity in this scope before generating insights';
    tokenUsage = 0;
  } else {
    // 5. Claude generates the *narrative* and *suggestion*. We
    //    deliberately discard whatever it returns for `trend` /
    //    `trendPct` — those come from `computeTrend` so the numeric
    //    answer is deterministic and matches the dashboard.
    const claudeResult = await generateInsight({
      scope,
      periodStart,
      periodEnd,
      metrics: aggregation.rawData,
    });
    summary = claudeResult.summary;
    suggestion = claudeResult.suggestion;
    tokenUsage = claudeResult.tokenUsage;
  }

  // 6. Persist.
  const insight = await prisma.aIInsight.create({
    data: {
      periodStart,
      periodEnd,
      scope,
      trend: localTrend.trend,
      trendPct: localTrend.trendPct,
      summary,
      suggestion,
      rawData: aggregation.rawData as Prisma.InputJsonValue,
      tokenUsage,
    },
  });

  // 7. Best-effort audit log — only when we have an acting user.
  if (userId !== undefined) {
    try {
      await logActivity(prisma, {
        userId,
        action: ACTIVITY_ACTIONS.AI_INSIGHT_GENERATED,
        entityType: 'ai_insight',
        entityId: insight.id,
        metadata: {
          scope,
          trend: localTrend.trend,
          trendPct: localTrend.trendPct,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[ai-insights] activity log failed', logErr);
    }
  }

  return insight;
}
