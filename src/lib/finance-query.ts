/**
 * Prisma `where` / `orderBy` builders for the transaction list. Shared by
 * `GET /api/finance/transactions` and the `/finance/transactions` page so
 * the API and the UI can never drift on filter semantics.
 *
 *   • `partyId` matches rows where the party is the counterparty OR the
 *     intermediary the money was routed through (`viaPartyId`), so a
 *     party's page shows everything that touched them.
 *   • `month` is a shortcut for a UTC month range; explicit
 *     `dateFrom` / `dateTo` win when both are present.
 *   • `search` looks at description, reference, party and via-party names.
 */

import type { Prisma } from '@prisma/client';

import { monthRange } from '@/lib/finance';
import type { FinanceTransactionListQuery } from '@/lib/schemas/finance';

export function buildTransactionWhere(
  query: FinanceTransactionListQuery,
): Prisma.FinanceTransactionWhereInput {
  const where: Prisma.FinanceTransactionWhereInput = {};
  const and: Prisma.FinanceTransactionWhereInput[] = [];

  if (query.direction !== undefined) where.direction = query.direction;
  if (query.category && query.category.length > 0) {
    where.category = { in: query.category };
  }
  if (query.partyId !== undefined) {
    and.push({ OR: [{ partyId: query.partyId }, { viaPartyId: query.partyId }] });
  }
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
    and.push({
      OR: [
        { description: { contains: query.search, mode: 'insensitive' } },
        { reference: { contains: query.search, mode: 'insensitive' } },
        { party: { name: { contains: query.search, mode: 'insensitive' } } },
        { viaParty: { name: { contains: query.search, mode: 'insensitive' } } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;
  return where;
}

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
