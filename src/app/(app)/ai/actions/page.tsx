/**
 * `/ai/actions` — admin-only prioritized action list (v0.1.3 Theme 5).
 *
 * Server Component. Reads `AIAction` rows directly from Prisma (same
 * pattern as `/ai/page.tsx`) and groups OPEN items by priority. Done
 * and dismissed items get a small collapsed section at the bottom.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ListChecks } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';

import { ActionCard } from './action-card';
import { GenerateActionsButton } from './generate-actions-button';

export const metadata = {
  title: 'AI Actions · OfficePilot',
};

export const dynamic = 'force-dynamic';

const PRIORITY_ORDER = ['HIGH', 'MEDIUM', 'LOW'] as const;

const PRIORITY_LABEL: Record<string, string> = {
  HIGH: '🔴 High — do today',
  MEDIUM: '🟡 Medium — this week',
  LOW: '🟢 Low — when time',
};

export default async function AIActionsPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/ai/actions');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  // Fetch open actions and recently resolved actions separately so the
  // page can render two sections without re-querying.
  const [open, resolved] = await Promise.all([
    prisma.aIAction.findMany({
      where: { status: 'OPEN' },
      orderBy: [{ generatedAt: 'desc' }, { id: 'asc' }],
      take: 200,
    }),
    prisma.aIAction.findMany({
      where: { status: { in: ['DONE', 'DISMISSED'] } },
      orderBy: [{ resolvedAt: 'desc' }, { id: 'asc' }],
      take: 20,
    }),
  ]);

  // Group OPEN by priority. Stable order matches PRIORITY_ORDER.
  const grouped: Record<string, typeof open> = { HIGH: [], MEDIUM: [], LOW: [] };
  for (const a of open) {
    if (a.priority in grouped) {
      grouped[a.priority].push(a);
    } else {
      grouped.LOW.push(a);
    }
  }

  const totalOpen = open.length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="AI Actions"
        subtitle="Prioritized to-do list generated from the latest AI insights. Mark items done as you action them."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/ai">← Back to Insights</Link>
            </Button>
            <GenerateActionsButton />
          </div>
        }
      />

      {totalOpen === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No open actions"
          description="Click Generate now to refresh the action list from the latest AI insights. The generator looks across ads, social, leads, overall, predictions, and anomalies."
        />
      ) : (
        <div className="space-y-6">
          {PRIORITY_ORDER.map((priority) => {
            const items = grouped[priority];
            if (items.length === 0) return null;
            return (
              <section key={priority} className="space-y-2">
                <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                  {PRIORITY_LABEL[priority]} ({items.length})
                </h2>
                <ol className="space-y-2">
                  {items.map((a) => (
                    <li key={a.id}>
                      <ActionCard
                        action={{
                          id: a.id,
                          priority: a.priority,
                          scope: a.scope,
                          title: a.title,
                          rationale: a.rationale,
                          status: a.status,
                          generatedAt: a.generatedAt.toISOString(),
                        }}
                      />
                    </li>
                  ))}
                </ol>
              </section>
            );
          })}
        </div>
      )}

      {resolved.length > 0 && (
        <details className="rounded-lg border bg-muted/20 p-4">
          <summary className="cursor-pointer select-none text-sm font-medium text-muted-foreground">
            Recently resolved ({resolved.length})
          </summary>
          <ol className="mt-3 space-y-2">
            {resolved.map((a) => (
              <li key={a.id}>
                <Card className="opacity-60">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-normal">
                      <span className="mr-2 text-xs uppercase tracking-wide text-muted-foreground">
                        {a.status === 'DONE' ? '✓ done' : '✗ dismissed'}
                      </span>
                      {a.title}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0 text-xs text-muted-foreground">
                    {a.scope} ·{' '}
                    {a.resolvedAt
                      ? new Date(a.resolvedAt).toLocaleString('en-IN', {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </CardContent>
                </Card>
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
