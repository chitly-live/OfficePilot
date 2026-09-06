/**
 * Credit-card overview loader (Prisma-backed): one row per CREDIT_CARD
 * account with outstanding, available limit, current billing cycle and
 * the next due date. Used by the Accounts page and the Finance overview.
 */

import type { PrismaClient } from '@prisma/client';

import {
  cardHealth,
  computeCardPosition,
  currentBillingCycle,
  type BillingCycle,
  type CardHealth,
  type CardLedgerRow,
  type CardPosition,
} from '@/lib/credit-card';

export interface CardOverview {
  id: string;
  name: string;
  ownerName: string | null;
  isActive: boolean;
  creditLimit: number | null;
  billingDay: number | null;
  dueDay: number | null;
  cycle: BillingCycle | null;
  position: CardPosition;
  health: CardHealth;
  /** Days until the next due date (negative = overdue); null without a due day. */
  daysToDue: number | null;
}

export async function loadCardOverview(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<CardOverview[]> {
  const cards = await db.financeAccount.findMany({
    where: { type: 'CREDIT_CARD' },
    select: {
      id: true,
      name: true,
      isActive: true,
      creditLimit: true,
      billingDay: true,
      dueDay: true,
      ownerParty: { select: { name: true } },
    },
    orderBy: [{ name: 'asc' }],
  });
  if (cards.length === 0) return [];

  const ids = cards.map((c) => c.id);
  const rows = await db.financeTransaction.findMany({
    where: { OR: [{ accountId: { in: ids } }, { settlesAccountId: { in: ids } }] },
    select: {
      date: true,
      direction: true,
      amount: true,
      accountId: true,
      settlesAccountId: true,
    },
  });

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return cards.map((card) => {
    const ledger: CardLedgerRow[] = rows
      .filter((r) => r.accountId === card.id || r.settlesAccountId === card.id)
      .map((r) => ({
        date: r.date,
        direction: r.direction,
        amount: r.amount,
        onCard: r.accountId === card.id,
        settlesCard: r.settlesAccountId === card.id,
      }));
    const cycle = card.billingDay ? currentBillingCycle(card.billingDay, now, card.dueDay) : null;
    const position = computeCardPosition(ledger, card.creditLimit, cycle);
    const daysToDue = cycle?.dueDate
      ? Math.round((cycle.dueDate.getTime() - today) / (24 * 60 * 60 * 1000))
      : null;
    return {
      id: card.id,
      name: card.name,
      ownerName: card.ownerParty?.name ?? null,
      isActive: card.isActive,
      creditLimit: card.creditLimit,
      billingDay: card.billingDay,
      dueDay: card.dueDay,
      cycle,
      position,
      health: cardHealth(position),
      daysToDue,
    };
  });
}
