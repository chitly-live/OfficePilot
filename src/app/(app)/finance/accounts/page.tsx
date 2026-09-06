/**
 * `/finance/accounts` — bank / cash / UPI / credit-card instruments with
 * balances. Admin-only.
 */

import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatInr } from '@/lib/finance';
import { loadCardOverview } from '@/lib/finance-cards';
import { loadAccountBalances } from '@/lib/finance-summary';
import {
  financeAccountProjection,
  type FinanceAccountPublic,
} from '@/lib/schemas/finance';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';

import { FinanceNav } from '../finance-nav';
import { AccountDialog } from './account-dialog';
import { AccountsTable, type AccountRow } from './accounts-table';

export const metadata = {
  title: 'Accounts · Finance',
};

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance/accounts');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const [rows, balances, parties, cards] = await Promise.all([
    prisma.financeAccount.findMany({
      select: financeAccountProjection,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }, { id: 'asc' }],
    }),
    loadAccountBalances(prisma),
    prisma.financeParty.findMany({
      where: { isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
      take: 500,
    }),
    loadCardOverview(prisma),
  ]);

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const items: AccountRow[] = rows.map((a) => ({
    ...(a as unknown as FinanceAccountPublic),
    balance: balances.get(a.id) ?? a.openingBalance,
    card: cardById.get(a.id) ?? null,
  }));

  const companyBalance = items
    .filter((a) => a.isActive && a.ownerPartyId === null)
    .reduce((sum, a) => sum + a.balance, 0);
  // Card outstanding = spend − refunds − repayments that settle each card.
  const borrowedSpend = cards.reduce((sum, c) => sum + Math.max(0, c.position.outstanding), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts"
        subtitle="Where the money sits — and which cards we've borrowed."
        actions={<AccountDialog mode="create" parties={parties} />}
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Company accounts balance"
          value={formatInr(companyBalance)}
        />
        <StatCard
          label="Outstanding on credit cards"
          value={formatInr(borrowedSpend)}
          invertColor
        />
        <StatCard label="Accounts" value={items.length} />
      </div>

      <AccountsTable
        items={items}
        parties={parties}
        emptyAction={<AccountDialog mode="create" parties={parties} />}
      />
    </div>
  );
}
