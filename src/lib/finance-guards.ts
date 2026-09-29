/**
 * Checks that stop money being recorded wrong before it reaches the ledger:
 *
 *   • `findPossibleDuplicates` — a new row that matches one already entered
 *     (same UTR, or same account + direction + amount within a day). The
 *     caller turns a hit into a warning the user can override: two identical
 *     IMPS charges on one day are real, a notebook line typed twice is not.
 *
 *   • `validateCardSplit` / `writeCardSplit` — ONE bank payment that cleared
 *     several credit cards. The ledger row stays exactly as the bank shows it;
 *     the per-card shares live in `CardRepaymentAllocation`. A row carries
 *     either `settlesAccountId` (one card) or a split, never both, so no rupee
 *     is counted twice.
 */

import type { FinanceCategory, FinanceDirection, Prisma } from '@prisma/client';

import { BadRequestError, ConflictError } from '@/lib/http-errors';
import { formatDateUtc, formatInr, round2 } from '@/lib/finance';
import type { FinanceDbClient } from '@/lib/finance-summary';

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

export interface DuplicateProbe {
  date: Date;
  direction: FinanceDirection;
  amount: number;
  accountId?: string | null;
  reference?: string | null;
}

export interface DuplicateCandidate {
  id: string;
  date: Date;
  direction: FinanceDirection;
  category: FinanceCategory;
  amount: number;
  description: string | null;
  reference: string | null;
  accountName: string | null;
  /** Why it matched — shown to the user. */
  reason: 'same_reference' | 'same_amount';
}

/** Pure matcher, exported for tests. */
export function isLikelyDuplicate(
  probe: DuplicateProbe,
  row: {
    date: Date;
    direction: FinanceDirection;
    amount: number;
    accountId: string | null;
    reference: string | null;
  },
): DuplicateCandidate['reason'] | null {
  if (row.direction !== probe.direction) return null;
  if (Math.abs(round2(row.amount) - round2(probe.amount)) >= 0.005) return null;
  // Same UTR, same money: the same bank line entered twice, whatever the
  // account. (A charge and its GST share one reference but differ in
  // amount, so they are not duplicates of each other.)
  const ref = probe.reference?.trim().toLowerCase();
  const rowRef = row.reference?.trim().toLowerCase();
  if (ref && rowRef && rowRef === ref) {
    return 'same_reference';
  }
  // Both carry a reference and they differ: two different bank lines, even
  // for the same amount on adjacent days (₹7 IMPS charges, say).
  if (ref && rowRef) return null;
  if (!probe.accountId || row.accountId !== probe.accountId) return null;
  if (Math.abs(row.date.getTime() - probe.date.getTime()) > DAY_MS) return null;
  return 'same_amount';
}

export async function findPossibleDuplicates(
  db: FinanceDbClient,
  probe: DuplicateProbe,
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const ref = probe.reference?.trim();
  const or: Prisma.FinanceTransactionWhereInput[] = [];
  const money = { gte: probe.amount - 0.005, lte: probe.amount + 0.005 };
  if (ref) {
    or.push({ reference: { equals: ref, mode: 'insensitive' }, direction: probe.direction, amount: money });
  }
  if (probe.accountId) {
    or.push({
      accountId: probe.accountId,
      direction: probe.direction,
      amount: money,
      date: {
        gte: new Date(probe.date.getTime() - DAY_MS),
        lte: new Date(probe.date.getTime() + DAY_MS),
      },
    });
  }
  if (or.length === 0) return [];

  const rows = await db.financeTransaction.findMany({
    where: { OR: or, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: {
      id: true,
      date: true,
      direction: true,
      category: true,
      amount: true,
      description: true,
      reference: true,
      accountId: true,
      account: { select: { name: true } },
    },
    orderBy: { date: 'desc' },
    take: 5,
  });

  const out: DuplicateCandidate[] = [];
  for (const r of rows) {
    const reason = isLikelyDuplicate(probe, r);
    if (!reason) continue;
    out.push({
      id: r.id,
      date: r.date,
      direction: r.direction,
      category: r.category,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
      accountName: r.account?.name ?? null,
      reason,
    });
  }
  return out;
}

/** Throw a 409 the form can show and override, when the probe matches. */
export async function assertNotDuplicate(
  db: FinanceDbClient,
  probe: DuplicateProbe,
  excludeId?: string,
): Promise<void> {
  const hits = await findPossibleDuplicates(db, probe, excludeId);
  if (hits.length === 0) return;
  const first = hits[0]!;
  const why =
    first.reason === 'same_reference'
      ? `the same reference (${first.reference}) is already on a row dated ${formatDateUtc(first.date)}`
      : `${formatInr(first.amount)} on ${first.accountName ?? 'this account'} is already recorded on ${formatDateUtc(first.date)}`;
  throw new ConflictError(
    'possible_duplicate',
    `This looks like an entry you already made: ${why}. Save it anyway if it is a separate payment.`,
    { duplicates: hits },
  );
}

// ---------------------------------------------------------------------------
// Card split
// ---------------------------------------------------------------------------

export interface CardSplitPart {
  accountId: string;
  amount: number;
}

/**
 * Checks a split without touching the database — shape, totals, no card
 * twice. `validateCardSplit` adds the "is it really a credit card" check.
 */
export function checkCardSplitShape(
  row: { category: FinanceCategory; direction: FinanceDirection; amount: number },
  parts: readonly CardSplitPart[],
): void {
  if (row.category !== 'CARD_REPAYMENT' || row.direction !== 'OUT') {
    throw new BadRequestError('Only a card repayment can be split across cards');
  }
  if (parts.length < 2) {
    throw new BadRequestError('A split needs at least two cards — use "Settles card" for one');
  }
  const ids = new Set(parts.map((p) => p.accountId));
  if (ids.size !== parts.length) {
    throw new BadRequestError('Each card can appear only once in a split');
  }
  if (parts.some((p) => !(round2(p.amount) > 0))) {
    throw new BadRequestError('Every card in the split needs an amount above zero');
  }
  // Compare what will be stored: each share rounded to the paisa.
  const total = round2(parts.reduce((s, p) => s + round2(p.amount), 0));
  if (Math.abs(total - round2(row.amount)) >= 0.005) {
    throw new BadRequestError(
      `The split adds up to ${formatInr(total)} but the payment is ${formatInr(row.amount)} — they must match to the paisa`,
    );
  }
}

export async function validateCardSplit(
  db: FinanceDbClient,
  row: { category: FinanceCategory; direction: FinanceDirection; amount: number },
  parts: readonly CardSplitPart[],
): Promise<void> {
  checkCardSplitShape(row, parts);
  const cards = await db.financeAccount.findMany({
    where: { id: { in: parts.map((p) => p.accountId) } },
    select: { id: true, type: true },
  });
  if (cards.length !== parts.length) throw new BadRequestError('Card not found');
  if (cards.some((c) => c.type !== 'CREDIT_CARD')) {
    throw new BadRequestError('A repayment can only settle a credit card');
  }
}

/** Replace a row's split. Clears `settlesAccountId` so nothing counts twice. */
export async function writeCardSplit(
  tx: Prisma.TransactionClient,
  transactionId: string,
  parts: readonly CardSplitPart[],
): Promise<void> {
  await tx.cardRepaymentAllocation.deleteMany({ where: { transactionId } });
  if (parts.length === 0) return;
  await tx.financeTransaction.update({
    where: { id: transactionId },
    data: { settlesAccountId: null },
  });
  await tx.cardRepaymentAllocation.createMany({
    data: parts.map((p) => ({
      transactionId,
      accountId: p.accountId,
      amount: round2(p.amount),
    })),
  });
}
