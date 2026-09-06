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
import { productWhere, scopeLabel } from '@/lib/products';
import { getProductContext } from '@/lib/products-server';
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

  const productContext = await getProductContext(prisma);
  const scope = productContext.scope;
  const scopeText = scopeLabel(scope, productContext.companyShort);

  const [rows, balances, parties, cards, scopedRows] = await Promise.all([
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
    scope.kind === 'all'
      ? Promise.resolve([])
      : prisma.financeTransaction.findMany({
          where: { ...productWhere(scope), accountId: { not: null } },
          select: { accountId: true, direction: true, amount: true },
        }),
  ]);

  // Flow per account inside the header product scope (product / company-level).
  const scopedByAccount = new Map<string, { moneyIn: number; moneyOut: number; count: number }>();
  for (const r of scopedRows) {
    if (!r.accountId) continue;
    const s = scopedByAccount.get(r.accountId) ?? { moneyIn: 0, moneyOut: 0, count: 0 };
    s.count += 1;
    if (r.direction === 'IN') s.moneyIn += r.amount;
    else s.moneyOut += r.amount;
    scopedByAccount.set(r.accountId, s);
  }

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const items: AccountRow[] = rows
    .filter((a) => scope.kind === 'all' || scopedByAccount.has(a.id))
    .map((a) => ({
      ...(a as unknown as FinanceAccountPublic),
      balance: balances.get(a.id) ?? a.openingBalance,
      card: cardById.get(a.id) ?? null,
      scoped: scopedByAccount.get(a.id) ?? null,
    }));
  const scopedIn = [...scopedByAccount.values()].reduce((s, v) => s + v.moneyIn, 0);
  const scopedOut = [...scopedByAccount.values()].reduce((s, v) => s + v.moneyOut, 0);

  const companyBalance = items
    .filter((a) => a.isActive && a.ownerPartyId === null)
    .reduce((sum, a) => sum + a.balance, 0);
  // Card outstanding = spend − refunds − repayments that settle each card.
  const borrowedSpend = cards.reduce((sum, c) => sum + Math.max(0, c.position.outstanding), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Accounts"
        subtitle={
          scope.kind === 'all'
            ? "Where the money sits — and which cards we've borrowed."
            : `${scopeText} — accounts and cards are company-level; this shows only what ${scopeText} moved through each.`
        }
        actions={<AccountDialog mode="create" parties={parties} />}
      />

      <FinanceNav />

      {scope.kind === 'all' ? (
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
      ) : (
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard label={`Money in (${scopeText})`} value={formatInr(scopedIn)} />
          <StatCard label={`Money out (${scopeText})`} value={formatInr(scopedOut)} invertColor />
          <StatCard label="Accounts used" value={items.length} />
        </div>
      )}

      <AccountsTable
        items={items}
        parties={parties}
        scopeLabel={scope.kind === 'all' ? null : scopeText}
        emptyAction={<AccountDialog mode="create" parties={parties} />}
      />
    </div>
  );
}
