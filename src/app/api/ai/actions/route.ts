/**
 * `/api/ai/actions` — admin-only AI action list + bulk generator
 * (v0.1.3 Theme 5).
 *
 * `GET  /api/ai/actions`
 * ----------------------
 * Paginated list of `AIAction` rows. Sorted by priority (HIGH > MEDIUM
 * > LOW), then `generatedAt DESC`, then `id ASC` so two items written
 * in the same millisecond keep a stable order.
 *
 * Query params (all optional):
 *
 *   • `status`   — filter by exact status. One of OPEN / DONE / DISMISSED.
 *   • `priority` — filter by exact priority. HIGH / MEDIUM / LOW.
 *   • `scope`    — filter by exact scope. ads / social / leads /
 *                  overall / predictions / anomalies.
 *   • `pageSize` — default 50, max 100.
 *
 * `POST /api/ai/actions`
 * ----------------------
 * Generate a fresh prioritized action list from the latest AI
 * insights and persist each item as a new `AIAction` row.
 *
 * Body (all optional):
 *
 *   • `scopes` — array of scopes to feed the generator. Defaults to
 *                all six (ads / social / leads / overall / predictions
 *                / anomalies).
 *
 * Behaviour:
 *
 *   • When `process.env.MOCK_ANTHROPIC === '1'`, the route persists a
 *     canned 3-item list instead of calling Claude. Mirrors the same
 *     env flag used by `src/lib/claude.ts` so Playwright runs (and
 *     any local "test the UI without a key" exercise) get a
 *     deterministic result. The flag is never set in production.
 *   • On success, writes a `ai.actions_generated` row to
 *     `ActivityLog` (best-effort — failures don't tank the request).
 *
 * Both surfaces are admin-only. `/ai` is already in
 * `ADMIN_ONLY_PATH_PREFIXES` in `src/middleware.ts`, but the route
 * handler calls `requireAdminSession()` defensively so a misconfigured
 * matcher cannot accidentally expose actions to employees.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { Prisma, type AIAction } from '@prisma/client';

import { prisma } from '@/lib/db';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  BadRequestError,
  errorResponse,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import {
  aiActionPriorityEnum,
  aiActionScopeEnum,
  generateAIActions,
  type AIActionScope,
} from '@/lib/ai-actions';

// Force the Node runtime — Prisma is not Edge-compatible.
export const runtime = 'nodejs';
// Each GET/POST may produce a fresh list; never serve a cached body.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard ceiling so a stray `pageSize=10000` can't blow up Postgres. */
const MAX_PAGE_SIZE = 100;
/** Mirrors the rest of the API so paginated UIs share one universe. */
const DEFAULT_PAGE_SIZE = 50;

/**
 * Order in which priorities sort. Postgres can't natively sort
 * arbitrary strings in this order, so we partition the query by
 * priority in JS (one findMany per priority, with `take` budgets so
 * the total never exceeds `pageSize`).
 *
 * `HIGH` first lines up with the SPEC.md UX ("do today first").
 */
const PRIORITY_ORDER = ['HIGH', 'MEDIUM', 'LOW'] as const;
type PriorityLabel = (typeof PRIORITY_ORDER)[number];

/**
 * Canned mock items for `MOCK_ANTHROPIC=1`. Three rows so the UI can
 * exercise its filter chips + priority sections without a real key.
 * Stored values intentionally short to keep test fixtures terse.
 */
const MOCK_ACTIONS: ReadonlyArray<{
  priority: PriorityLabel;
  scope: AIActionScope;
  title: string;
  rationale: string;
}> = [
  {
    priority: 'HIGH',
    scope: 'ads',
    title: 'Pause underperforming Meta Reels campaign',
    rationale:
      'CAC on the Reels Mumbai set is ₹420 — 3.2× the channel average. Pause and reallocate to top-performing creative while you decide on next steps.',
  },
  {
    priority: 'MEDIUM',
    scope: 'leads',
    title: 'Follow up with 14 day-5+ NEW leads',
    rationale:
      '14 leads have sat in NEW for ≥5 days; SPEC.md §6.2.2 calls these stale. Assign owners or auto-route to the nightshift queue.',
  },
  {
    priority: 'LOW',
    scope: 'social',
    title: 'Document winning Reels caption template',
    rationale:
      'Two posts marked as winners this week share the same caption pattern. Capture the template in the playbook so the next two posts can A/B against it.',
  },
];

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/** Status filter on the GET endpoint. Same vocabulary as the schema. */
const aiActionStatusEnum = z.enum(['OPEN', 'DONE', 'DISMISSED']);

/**
 * Query schema for `GET /api/ai/actions`. All filters optional. Coerce
 * + default the `pageSize` so the route hands the DB a clean integer.
 */
const aiActionListQuerySchema = z.object({
  status: aiActionStatusEnum.optional(),
  priority: aiActionPriorityEnum.optional(),
  scope: aiActionScopeEnum.optional(),
  pageSize: z.coerce
    .number()
    .int('pageSize must be an integer')
    .positive('pageSize must be positive')
    .max(MAX_PAGE_SIZE, `pageSize cannot exceed ${MAX_PAGE_SIZE}`)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * Body schema for `POST /api/ai/actions`. Empty body is fine — the
 * generator defaults to all six scopes.
 */
const aiActionGenerateSchema = z.object({
  scopes: z.array(aiActionScopeEnum).min(1).optional(),
});

// ---------------------------------------------------------------------------
// GET /api/ai/actions
// ---------------------------------------------------------------------------

/**
 * Return the paginated, prioritized list. Admin-only.
 *
 * Why the priority-partitioned read? Postgres has no native way to
 * sort `'HIGH' > 'MEDIUM' > 'LOW'` short of a CASE expression, and
 * Prisma's `orderBy` doesn't expose raw CASE. Three `findMany` calls
 * with `take` budgets is trivially cheap at our row volumes and keeps
 * the surface readable. When a `priority` filter is supplied we skip
 * the partitioning entirely.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();

    const query = parseSearchParams(req.nextUrl.searchParams, aiActionListQuerySchema);

    const baseWhere: Prisma.AIActionWhereInput = {};
    if (query.status !== undefined) baseWhere.status = query.status;
    if (query.scope !== undefined) baseWhere.scope = query.scope;

    let items: AIAction[];

    if (query.priority !== undefined) {
      // Single priority — no partitioning needed.
      items = await prisma.aIAction.findMany({
        where: { ...baseWhere, priority: query.priority },
        orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
        take: query.pageSize,
      });
    } else {
      // Pull each priority bucket in HIGH → MEDIUM → LOW order, with a
      // shrinking budget so the union never exceeds `pageSize`.
      const buckets: AIAction[] = [];
      let remaining = query.pageSize;
      for (const priority of PRIORITY_ORDER) {
        if (remaining <= 0) break;
        const bucket = await prisma.aIAction.findMany({
          where: { ...baseWhere, priority },
          orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
          take: remaining,
        });
        buckets.push(...bucket);
        remaining -= bucket.length;
      }
      items = buckets;
    }

    // Total respects only the structural filters (status + scope +
    // priority when set), not pagination — clients use it to render
    // counts / "showing N of M" labels.
    const total = await prisma.aIAction.count({
      where: query.priority !== undefined
        ? { ...baseWhere, priority: query.priority }
        : baseWhere,
    });

    return NextResponse.json({
      items,
      total,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/ai/actions
// ---------------------------------------------------------------------------

/**
 * Generate a fresh action list and persist each item. Admin-only.
 * Returns `{ items: AIAction[] }` with status 201.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    // Empty body is fine — defaults to all six scopes. We tolerate a
    // missing or invalid-JSON body so the "Generate now" button can
    // post with no payload.
    let rawBody: unknown = {};
    const contentLength = req.headers.get('content-length');
    if (contentLength !== '0' && contentLength !== null) {
      try {
        rawBody = await req.json();
      } catch {
        rawBody = {};
      }
    }
    const parsed = aiActionGenerateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestError('Validation failed', parsed.error);
    }
    const { scopes } = parsed.data;

    let items: AIAction[];

    if (process.env.MOCK_ANTHROPIC === '1') {
      // Persist the canned mock list so the response shape matches
      // production and the "Generated now" path exercises the writer.
      items = [];
      for (const mock of MOCK_ACTIONS) {
        const created = await prisma.aIAction.create({
          data: {
            priority: mock.priority,
            scope: mock.scope,
            title: mock.title,
            rationale: mock.rationale,
            status: 'OPEN',
          },
        });
        items.push(created);
      }
    } else {
      items = await generateAIActions({
        userId: session.userId,
        scopes,
      });
    }

    // Best-effort audit log. Mirrors `ai.insight_generated` (see
    // `src/lib/ai-insights.ts`) — a missing audit row never tanks a
    // successful generate.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.AI_ACTIONS_GENERATED,
        entityType: 'ai_action',
        // No single entityId — use a synthetic marker so the
        // ActivityLog row is still indexable per the schema.
        entityId: 'batch',
        metadata: {
          count: items.length,
          ...(scopes ? { scopes: [...scopes] } : {}),
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/ai/actions] activity log failed', logErr);
    }

    return NextResponse.json({ items }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
