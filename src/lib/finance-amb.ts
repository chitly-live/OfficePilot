/**
 * Loader that turns the ledger into an AMB position per bank account.
 * Thin DB layer around the pure helpers in `src/lib/amb.ts`.
 */

import type { PrismaClient } from '@prisma/client';

import { computeAmb, type AmbResult } from '@/lib/amb';

export interface AccountAmb extends AmbResult {
  accountId: string;
  accountName: string;
}

/**
 * AMB for every active bank account that has a requirement set.
 *
 * `month` is `YYYY-MM`. For the current month only the days up to `today`
 * count; a past month counts every day.
 */
export async function loadAccountAmb(
  db: PrismaClient,
  month: string,
  today: Date = new Date(),
): Promise<AccountAmb[]> {
  const accounts = await db.financeAccount.findMany({
    where: { type: 'BANK', isActive: true, requiredAmb: { gt: 0 } },
    select: { id: true, name: true, openingBalance: true, requiredAmb: true },
    orderBy: [{ name: 'asc' }],
  });
  if (accounts.length === 0) return [];

  const [y, m] = month.split('-').map(Number);
  const monthEnd = new Date(Date.UTC(y, m, 0));
  // Only whole days that have closed count towards the average.
  const throughDay =
    today.getTime() >= monthEnd.getTime()
      ? monthEnd.getUTCDate()
      : today.getUTCFullYear() === y && today.getUTCMonth() === m - 1
        ? today.getUTCDate()
        : 0;

  const rows = await db.financeTransaction.findMany({
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      date: { lte: monthEnd },
    },
    select: { accountId: true, date: true, direction: true, amount: true },
    orderBy: [{ date: 'asc' }],
  });

  return accounts.map((account) => ({
    accountId: account.id,
    accountName: account.name,
    ...computeAmb({
      openingBalance: account.openingBalance,
      rows: rows.filter((r) => r.accountId === account.id),
      month,
      required: account.requiredAmb,
      throughDay,
    }),
  }));
}
