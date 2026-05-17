/**
 * `/ai` — admin-only AI insight feed (SPEC.md §10.1, §10.2).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate. The middleware (`src/middleware.ts`) already 403s
 *      EMPLOYEEs out of `/ai`, but we re-check `session.role` here as
 *      defence-in-depth: a misconfigured matcher mustn't ever expose
 *      AI cost data (SPEC.md §2.1, §11.5). Admin sees the full row
 *      including `tokenUsage`.
 *   2. Read URL search params: `scope?: 'ads' | 'social' | 'leads' |
 *      'overall'` and `page?: number`. Anything else is ignored.
 *   3. Query Prisma directly — same projection the API uses, sorted
 *      `generatedAt DESC, id ASC` so the freshest insight is at the
 *      top and rows generated in the same millisecond (e.g. the
 *      daily digest batch) keep a stable order.
 *   4. Render a header (with the "Generate now" client modal), the
 *      scope tabs as a filter bar, the feed of cards, and a pager.
 *
 * The page composes three client islands:
 *
 *   • `<GenerateInsightButton />` — opens a modal that POSTs to
 *     `/api/ai/generate`.
 *   • `<ScopeTabs />`             — pushes `?scope=` to the URL.
 *   • `<MarkActionedButton />`    — POSTs to `/api/ai/insights/[id]/
 *                                    action` with an optional note.
 *
 * Why direct Prisma instead of fetching `/api/ai/insights`? RSC best
 * practice in this codebase (see `/dev`, `/marketing`, `/employees`):
 * skip the HTTP round-trip for SSR, share the same projection, and
 * keep the API layer for client islands.
 *
 * Implements task 70 of `.kiro/specs/officepilot/tasks.md`.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Sparkles } from 'lucide-react';
import { Prisma } from '@prisma/client';
import { formatDistanceToNow } from 'date-fns';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { aiScopeEnum, type AIScope } from '@/lib/schemas/ai';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';
import { StatusBadge } from '@/components/shared/StatusBadge';

import { GenerateInsightButton } from './generate-button';
import { MarkActionedButton } from './mark-actioned-button';
import { ScopeTabs } from './scope-tabs';

export const metadata = {
  title: 'AI Insights',
};

// AI insights are generated continuously by the daily digest cron and
// the on-demand button — never serve a cached body.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Insights per page. Matches the API default and keeps the feed
 *  scannable on a 1080p laptop screen. */
const PAGE_SIZE = 20;

/**
 * Same projection as `GET /api/ai/insights` for ADMINs. Listed
 * verbatim (rather than imported) so a future column on `AIInsight`
 * surfaces here as a typed property automatically.
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
  tokenUsage: true,
} as const satisfies Prisma.AIInsightSelect;

type AIInsightFeedRow = Prisma.AIInsightGetPayload<{
  select: typeof aiInsightAdminProjection;
}>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce Next.js's `string | string[] | undefined` searchParam shape
 * into a single string. We don't accept multi-value query keys here
 * (the AI feed has no multi-select), so an array becomes its first
 * non-empty entry.
 */
function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const first = raw.find((v) => typeof v === 'string' && v.length > 0);
    return first ?? undefined;
  }
  return raw === '' ? undefined : raw;
}

/** Parse `?page=` defensively. Bad values fall back to 1 instead of
 *  500ing the page. */
function parsePage(raw: string | undefined): number {
  if (raw === undefined) return 1;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** Trend → emoji per SPEC.md §10.2 feature 4. */
function trendEmoji(trend: string): string {
  if (trend === 'up') return '🟢';
  if (trend === 'down') return '🔴';
  return '🟡';
}

const SCOPE_LABEL: Record<AIScope, string> = {
  ads: 'Ads',
  social: 'Social',
  leads: 'Leads',
  overall: 'Overall',
  predictions: 'Predictions',
  anomalies: 'Anomalies',
};

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function fmtDateRange(start: Date, end: Date): string {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  return `${fmt.format(start)} → ${fmt.format(end)}`;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface AIPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function AIPage({ searchParams }: AIPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate (defence-in-depth — middleware already enforces this).
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/ai');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  // ------------------------------------------------------------------
  // 2. Parse search params.
  // ------------------------------------------------------------------
  const rawScope = coerceParam(searchParams?.scope);
  const scopeParse = rawScope ? aiScopeEnum.safeParse(rawScope) : undefined;
  const scope: AIScope | undefined = scopeParse?.success
    ? scopeParse.data
    : undefined;

  const page = parsePage(coerceParam(searchParams?.page));

  // ------------------------------------------------------------------
  // 3. Query.
  // ------------------------------------------------------------------
  const where: Prisma.AIInsightWhereInput = {};
  if (scope !== undefined) {
    where.scope = scope;
  }

  const skip = (page - 1) * PAGE_SIZE;

  const [items, total] = await Promise.all([
    prisma.aIInsight.findMany({
      where,
      select: aiInsightAdminProjection,
      orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
      skip,
      take: PAGE_SIZE,
    }),
    prisma.aIInsight.count({ where }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Insights"
        subtitle="Claude-generated weekly summaries across ads, social, leads, overall, predictions, and anomalies."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/ai/actions">View Action List →</Link>
            </Button>
            <GenerateInsightButton />
          </div>
        }
      />

      <ScopeTabs currentScope={scope ?? null} />

      {items.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title="No insights yet"
          description={
            scope
              ? `No ${SCOPE_LABEL[scope].toLowerCase()} insights for this filter. Generate one or pick another scope.`
              : 'Generate your first insight or wait for the daily digest to run.'
          }
          action={<GenerateInsightButton variant="empty-state" />}
        />
      ) : (
        <ol className="space-y-3">
          {items.map((insight) => (
            <li key={insight.id}>
              <InsightCard insight={insight} />
            </li>
          ))}
        </ol>
      )}

      <Pagination
        page={page}
        pageSize={PAGE_SIZE}
        total={total}
        basePath="/ai"
        searchParams={{ scope }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// InsightCard
// ---------------------------------------------------------------------------

interface InsightCardProps {
  insight: AIInsightFeedRow;
}

function InsightCard({ insight }: InsightCardProps) {
  const scopeLabel =
    (SCOPE_LABEL as Record<string, string>)[insight.scope] ?? insight.scope;

  return (
    <Card>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span aria-hidden="true" className="text-xl leading-none">
              {trendEmoji(insight.trend)}
            </span>
            <StatusBadge
              status={insight.scope.toUpperCase()}
              tone="blue"
              label={scopeLabel}
            />
            <span className="text-xs text-muted-foreground">
              {fmtPct(insight.trendPct)}
            </span>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>
              {formatDistanceToNow(new Date(insight.generatedAt), {
                addSuffix: true,
              })}
            </div>
            <div>
              {fmtDateRange(
                new Date(insight.periodStart),
                new Date(insight.periodEnd),
              )}
            </div>
          </div>
        </div>
        <CardTitle className="text-base font-semibold leading-snug">
          {insight.summary}
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0">
        <details className="group rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <summary className="cursor-pointer select-none text-xs font-medium uppercase tracking-wide text-muted-foreground group-open:mb-2">
            Suggestion
          </summary>
          <p className="whitespace-pre-line text-foreground">
            {insight.suggestion}
          </p>
        </details>
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-2 pt-0">
        <span className="text-xs text-muted-foreground">
          {insight.tokenUsage !== null && insight.tokenUsage !== undefined
            ? `${insight.tokenUsage.toLocaleString('en-IN')} tokens`
            : '0 tokens'}
        </span>
        <div className="flex items-center gap-2">
          <MarkActionedButton
            insightId={insight.id}
            scope={insight.scope}
            size="sm"
          />
          <Button asChild size="sm" variant="outline">
            <Link href={`/ai/${insight.id}`}>View details</Link>
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}
