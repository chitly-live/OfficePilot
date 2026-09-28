/**
 * Server-side loaders for the asset pages: the people an asset can be handed
 * to, and the payments an asset can be linked to.
 */

import { formatDateUtc, toDateKey } from '@/lib/finance';
import type { FinanceDbClient } from '@/lib/finance-summary';

export async function loadAssetPeople(db: FinanceDbClient) {
  const [users, parties] = await Promise.all([
    db.user.findMany({
      where: { isActive: true, role: { not: 'ACCOUNTANT' } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
    // A party that is also a panel user shows up once, under Team.
    db.financeParty.findMany({
      where: { isActive: true, userId: null, type: { notIn: ['CLIENT', 'INTERMEDIARY'] } },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  return { users, parties };
}

/**
 * Money-out rows not yet linked to an asset, newest first — plus `keepId`
 * (the asset's own payment when editing). Asset purchases and small office
 * buys first, since those are what an asset is usually paid by.
 */
export async function loadAssetPayments(db: FinanceDbClient, keepId?: string | null) {
  const rows = await db.financeTransaction.findMany({
    where: {
      direction: 'OUT',
      OR: [{ asset: null }, ...(keepId ? [{ id: keepId }] : [])],
      category: { notIn: ['CARD_REPAYMENT', 'LOAN_REPAYMENT', 'PAYOUT', 'SALARY', 'TAX', 'BANK_CHARGES'] },
    },
    select: {
      id: true,
      date: true,
      amount: true,
      category: true,
      description: true,
      account: { select: { name: true } },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    take: 150,
  });
  const likely = new Set(['ASSET_PURCHASE', 'OFFICE', 'SOFTWARE', 'UTILITIES', 'OTHER_EXPENSE']);
  return rows
    .sort((a, b) => Number(likely.has(b.category)) - Number(likely.has(a.category)))
    .map((r) => ({
      id: r.id,
      date: toDateKey(r.date),
      amount: r.amount,
      label: `${r.description ?? 'Payment'}${r.account ? ` (${r.account.name})` : ''}`,
      when: formatDateUtc(r.date),
    }));
}
