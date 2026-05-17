/**
 * Zod schemas + DTO types for the AI Analysis module (SPEC.md §10).
 *
 * Single source of truth for validating request payloads and query
 * strings on:
 *
 *   • POST   /api/ai/generate          → `aiGenerateSchema`
 *       Body for the admin-only on-demand insight generator
 *       (SPEC.md §10.5). The route in `src/app/api/ai/generate/route.ts`
 *       computes a same-duration previous window from `periodStart`,
 *       runs the right scope aggregation, and persists an `AIInsight`
 *       row.
 *
 *   • GET    /api/ai/insights          → `aiInsightListQuerySchema`
 *       Query string for the paginated list of stored insights
 *       (SPEC.md §10.5; implemented in task 67). Optional `scope`
 *       filter; standard `page` + `pageSize` pagination.
 *
 * The `scope` enum (`'ads' | 'social' | 'leads' | 'overall' |
 * 'predictions' | 'anomalies'`) mirrors the scopes the AI prompt reasons
 * about (SPEC.md §10.3) and the string values stored in `AIInsight.scope`.
 * Keep the members in sync with `InsightScope` in `src/lib/claude.ts`
 * and the dispatch `switch` in the generate route.
 *
 * Reused by the corresponding `react-hook-form` forms (the "Generate
 * insight" panel on `/ai`) via `@hookform/resolvers/zod` so client and
 * server share one validation contract (SPEC.md §13.5 — never trust
 * client-only validation).
 *
 * Implements task 66 of `.kiro/specs/officepilot/tasks.md`. The list
 * query schema also unblocks task 67.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Field-level constants
// ---------------------------------------------------------------------------

const DEFAULT_PAGE = 1;
/** Mirrors the rest of the API (SPEC.md §6.3) so paginated UIs can share
 *  one universe of page sizes. */
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

/**
 * The scopes the AI Analysis module reasons about. Stored verbatim in
 * `AIInsight.scope` (a plain `String` column — see SPEC.md §3 /
 * `prisma/schema.prisma`). The Claude wrapper's `InsightScope` type uses
 * the same members.
 *
 * v0.1.3 added two scopes (the underlying `String` column already accepts
 * any value, so no migration was required):
 *   - `predictions` — naive 7-day linear forecast for spend / leads / CAC.
 *   - `anomalies`   — z-score-based spike & drop detection vs. 7-day
 *                     rolling baseline.
 */
export const aiScopeEnum = z.enum([
  'ads',
  'social',
  'leads',
  'overall',
  'predictions',
  'anomalies',
]);

/** Branded TypeScript alias for the scope strings. */
export type AIScope = z.infer<typeof aiScopeEnum>;

/**
 * Convenience constant for callers that need the full set of scopes at
 * runtime (e.g. a dropdown that iterates all options, or an admin tool
 * that loops over every scope). Mirrors `aiScopeEnum.options` but with a
 * stable readonly tuple type so it can be used in `as const`-style
 * iteration. Keep in sync with `aiScopeEnum` above and the dispatch
 * `switch` in `generateScopeInsight` (`src/lib/ai-insights.ts`).
 */
export const ALL_AI_SCOPES: readonly AIScope[] = [
  'ads',
  'social',
  'leads',
  'overall',
  'predictions',
  'anomalies',
] as const;

/**
 * Accepts an ISO-8601 datetime string (e.g. `"2026-05-16T03:00:00Z"`)
 * or a `Date` object and yields a `Date`. `z.coerce.date()` handles
 * both — `new Date(string)` for strings, identity for Date inputs —
 * while still rejecting nonsense like `"not a date"` (which yields an
 * Invalid Date that Zod catches).
 */
const isoDateTime = z.coerce.date();

// ---------------------------------------------------------------------------
// 1. POST /api/ai/generate — admin-only insight generation
// ---------------------------------------------------------------------------

/**
 * Body schema for `POST /api/ai/generate` (SPEC.md §10.5).
 *
 *   • `scope`        — which slice of the business to analyse.
 *   • `periodStart`  — inclusive lower bound of the window. The route
 *                      derives `prevStart`/`prevEnd` as the same-
 *                      duration window ending immediately before
 *                      `periodStart`.
 *   • `periodEnd`    — inclusive upper bound of the window. Must be
 *                      strictly later than `periodStart`; an equal or
 *                      reversed range is rejected with a 400.
 *
 * The route handler (task 66) is responsible for:
 *   1. Auth guard → reject if `session.role !== 'ADMIN'` (SPEC.md §10.5
 *      "admin-only").
 *   2. Dispatching to the right `aggregate*` function based on `scope`.
 *   3. Computing the numeric trend in code (SPEC.md §10.2 feature 3).
 *   4. Short-circuiting to an "Insufficient data" insight without
 *      calling Claude when both current and previous metrics are zero
 *      (SPEC.md §10.7).
 *   5. Calling `generateInsight(...)` and overriding `trend` /
 *      `trendPct` with the locally-computed values.
 *   6. Persisting an `AIInsight` row and logging
 *      `ai.insight_generated` to ActivityLog.
 */
export const aiGenerateSchema = z
  .object({
    scope: aiScopeEnum,
    periodStart: isoDateTime,
    periodEnd: isoDateTime,
  })
  // Reject `periodStart >= periodEnd` so the window is always a
  // strictly positive duration. Equal timestamps would yield a
  // zero-length previous window and confuse the trend calculation;
  // a reversed range is almost certainly a client bug.
  .refine((value) => value.periodStart < value.periodEnd, {
    message: 'periodStart must be before periodEnd',
    path: ['periodStart'],
  });

export type AIGenerateInput = z.infer<typeof aiGenerateSchema>;

// ---------------------------------------------------------------------------
// 2. GET /api/ai/insights — list with optional scope filter
// ---------------------------------------------------------------------------

/**
 * Query-string schema for `GET /api/ai/insights` (SPEC.md §10.5;
 * implemented in task 67).
 *
 * Conventions:
 *   • Query params arrive as strings (or `undefined`). `z.coerce` turns
 *     `"42"` into `42` and a missing param into the `default()`.
 *   • `scope` is optional — the dashboard's "All scopes" view passes
 *     it absent and the per-scope card views pass it set.
 *   • `page` and `pageSize` mirror the rest of the OfficePilot API so
 *     a generic paginated table component can drive any list endpoint.
 */
export const aiInsightListQuerySchema = z.object({
  scope: aiScopeEnum.optional(),
  page: z.coerce
    .number()
    .int('Page must be an integer')
    .positive('Page must be positive')
    .default(DEFAULT_PAGE),
  pageSize: z.coerce
    .number()
    .int('Page size must be an integer')
    .positive('Page size must be positive')
    .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
});

export type AIInsightListQuery = z.infer<typeof aiInsightListQuerySchema>;
