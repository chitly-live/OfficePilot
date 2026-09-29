/**
 * `/finance/reconcile` — check the ledger against a bank statement, add what
 * is missing, then close the month so the checked figures cannot move.
 *
 * The accountant can compare (nothing is stored); adding rows and closing
 * months are admin-only.
 */

import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { canManageFinance, canViewFinance } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { lastEndedMonth, latestClosedMonth, loadMonthCloses } from '@/lib/month-close';
import { PageHeader } from '@/components/shared/PageHeader';

import { FinanceNav } from '../finance-nav';
import { MonthCloseCard } from './month-close-card';
import { ReconcileTool } from './reconcile-tool';

export const metadata = { title: 'Reconcile · Finance' };
export const dynamic = 'force-dynamic';

export default async function ReconcilePage() {
  const session = await auth();
  if (!session?.userId) redirect('/login?callbackUrl=/finance/reconcile');
  if (!canViewFinance(session.role)) redirect('/dashboard');
  const canEdit = canManageFinance(session.role);

  const [accounts, cards, parties, product, closes, lockedThrough] = await Promise.all([
    prisma.financeAccount.findMany({
      where: { isActive: true, type: { not: 'CREDIT_CARD' } },
      select: { id: true, name: true, type: true },
      orderBy: [{ type: 'asc' }, { name: 'asc' }],
    }),
    prisma.financeAccount.findMany({
      where: { isActive: true, type: 'CREDIT_CARD' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.financeParty.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    prisma.product.findFirst({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    }),
    loadMonthCloses(prisma),
    latestClosedMonth(prisma),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reconcile"
        subtitle="Paste the bank statement — the panel lines it up with the ledger to the paisa, shows what is missing or extra, and lets you lock the month once it matches."
      />

      <FinanceNav />

      <ReconcileTool
        accounts={accounts.map((a) => ({ id: a.id, name: a.name }))}
        cards={cards}
        parties={parties}
        productId={product?.id ?? null}
        canEdit={canEdit}
        lockedThrough={lockedThrough}
      />

      <MonthCloseCard
        closes={closes.map((c) => ({
          month: c.month,
          closedAt: c.closedAt.toISOString(),
          closedBy: c.closedBy,
          note: c.note,
          balances: c.balances,
          drift: c.drift,
        }))}
        lockedThrough={lockedThrough}
        suggested={lastEndedMonth()}
        canEdit={canEdit}
      />
    </div>
  );
}
