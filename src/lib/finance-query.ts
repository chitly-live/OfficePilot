/**
 * Finance module — Prisma `where` / `orderBy` builders for the ledger
 * list, shared by `GET /api/finance/transactions` and the
 * `/finance/transactions` page so both surfaces filter identically.
 */

import type { Prisma } from '@prisma/client';

import { monthRange } from '@/lib/finance';
import type { FinanceTransactionListQuery } from '@/lib/schemas/finance';

/**
 * Translate a parsed list query into a Prisma `where`. `month` is a
 * shortcut for one UTC month; explicit `dateFrom` / `dateTo` win when
 * present.
 */
export function buildTransactionWhere(
  query: FinanceTransactionListQuery,
): Prisma.FinanceTransactionWhereInput {
  const where: Prisma.FinanceTransactionWhereInput = {};

  if (query.direction !== undefined) where.direction = query.direction;
  if (query.category && query.category.length > 0) {
    where.category = { in: query.category };
  }
  if (query.partyId !== undefined) where.partyId = query.partyId;
  if (query.accountId !== undefined) where.accountId = query.accountId;

  let from = query.dateFrom;
  let to = query.dateTo;
  if (from === undefined && to === undefined && query.month !== undefined) {
    const range = monthRange(query.month);
    if (range) {
      from = range.from;
      to = range.to;
    }
  }
  if (from !== undefined || to !== undefined) {
    where.date = {
      ...(from !== undefined ? { gte: from } : {}),
      ...(to !== undefined ? { lte: to } : {}),
    };
  }

  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { reference: { contains: query.search, mode: 'insensitive' } },
      { party: { name: { contains: query.search, mode: 'insensitive' } } },
    ];
  }

  return where;
}

/** Stable ordering for the ledger list. */
export function buildTransactionOrderBy(
  query: Pick<FinanceTransactionListQuery, 'sortBy' | 'sortDir'>,
): Prisma.FinanceTransactionOrderByWithRelationInput[] {
  if (query.sortBy === 'amount') {
    return [{ amount: query.sortDir }, { date: 'desc' }, { id: 'asc' }];
  }
  if (query.sortBy === 'created') {
    return [{ createdAt: query.sortDir }, { id: 'asc' }];
  }
  return [{ date: query.sortDir }, { createdAt: query.sortDir }, { id: 'asc' }];
}
