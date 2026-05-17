/**
 * `/ai/[id]` — admin-only AI insight detail (SPEC.md §10.1, §10.2).
 *
 * Server Component. Renders the full snapshot for one `AIInsight`
 * row: scope, trend, percentage change, period, summary,
 * suggestion, token usage, and the verbatim `rawData` JSON that
 * Claude saw. The raw data is rendered as a syntax-highlighted
 * `<pre>` block scoped to a max height so a noisy aggregation
 * doesn't blow out the page.
 *
 * Auth gate
 * ---------
 * The middleware already 403s EMPLOYEEs out of `/ai/*`, but we
 * re-check here as defence-in-depth so a misconfigured matcher
 * cannot leak Claude spend data (SPEC.md §11.5 — admins only).
 *
 * 404 handling
 * ------------
 * `findUnique` followed by `notFound()` so the App Router renders
 * the standard 404 page. We don't use `findUniqueOrThrow` because
 * P2025 turning into a 500 inside a server component is uglier than
 * a clean `notFound()`.
 *
 * Implements task 70 of `.kiro/specs/officepilot/tasks.md`.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';

import { MarkActionedButton } from '../mark-actioned-button';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCOPE_LABEL: Record<string, string> = {
  ads: 'Ads',
  social: 'Social',
  leads: 'Leads',
  overall: 'Overall',
};

function trendEmoji(trend: string): string {
  if (trend === 'up') return '🟢';
  if (trend === 'down') return '🔴';
  return '🟡';
}

function fmtPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

function fmtDate(value: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(value);
}

function safeStringifyRawData(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Defensive — Prisma's `Json` type is JSON-stringify-safe in
    // practice, but a custom toJSON throwing is cheap to handle.
    return '/* unable to stringify rawData */';
  }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const insight = await prisma.aIInsight.findUnique({
    where: { id: params.id },
    select: { scope: true },
  });
  if (!insight) return { title: 'Insight' };
  const label = SCOPE_LABEL[insight.scope] ?? insight.scope;
  return { title: `${label} insight` };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function AIInsightDetailPage({ params }: PageProps) {
  // 1. Auth gate.
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/ai/${params.id}`);
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  // 2. Fetch. `findUnique` + `notFound()` is friendlier than
  //    `findUniqueOrThrow` in a server component (no 500 banner).
  const insight = await prisma.aIInsight.findUnique({
    where: { id: params.id },
    select: {
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
    },
  });
  if (!insight) {
    notFound();
  }

  const scopeLabel = SCOPE_LABEL[insight.scope] ?? insight.scope;
  const generatedAt = new Date(insight.generatedAt);
  const periodStart = new Date(insight.periodStart);
  const periodEnd = new Date(insight.periodEnd);

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span aria-hidden="true">{trendEmoji(insight.trend)}</span>
            <span>{scopeLabel} insight</span>
          </span>
        }
        subtitle={`Generated ${formatDistanceToNow(generatedAt, {
          addSuffix: true,
        })}`}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/ai">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back to feed</span>
              </Link>
            </Button>
            <MarkActionedButton
              insightId={insight.id}
              scope={insight.scope}
              size="sm"
            />
          </div>
        }
      />

      {/* Headline metrics. */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Scope"
          value={
            <StatusBadge
              status={insight.scope.toUpperCase()}
              tone="blue"
              label={scopeLabel}
            />
          }
        />
        <StatCard
          label="Trend"
          value={
            <span className="inline-flex items-center gap-2">
              <span aria-hidden="true">{trendEmoji(insight.trend)}</span>
              <span className="capitalize">{insight.trend}</span>
            </span>
          }
        />
        <StatCard label="Change" value={fmtPct(insight.trendPct)} />
        <StatCard
          label="Tokens used"
          value={
            insight.tokenUsage !== null && insight.tokenUsage !== undefined
              ? insight.tokenUsage.toLocaleString('en-IN')
              : '0'
          }
        />
      </div>

      {/* Summary + suggestion. */}
      <Card>
        <CardHeader>
          <CardTitle>Summary</CardTitle>
          <CardDescription>
            Period {fmtDate(periodStart)} → {fmtDate(periodEnd)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-line text-sm text-foreground">
            {insight.summary}
          </p>
          <div className="rounded-md border bg-muted/30 p-4">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Suggestion
            </h3>
            <p className="whitespace-pre-line text-sm text-foreground">
              {insight.suggestion}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Raw aggregation snapshot — admins only (which is everyone
          who reaches this page). The `<pre>` is height-capped so a
          noisy aggregation can't push the rest of the page off-screen. */}
      <Card>
        <CardHeader>
          <CardTitle>Raw data</CardTitle>
          <CardDescription>
            The metric snapshot Claude analysed. Useful for debugging
            unexpected summaries.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-[480px] overflow-auto rounded-md border bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
            <code>{safeStringifyRawData(insight.rawData)}</code>
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
