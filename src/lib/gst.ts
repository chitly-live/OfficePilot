/**
 * Monthly GST returns — the one thing the accountant writes.
 *
 * A return says how the month's liability was settled: `itcUsed` (input
 * tax credit — no cash moves) and `cashPaid` (through the GST portal).
 * Saving keeps two TAX rows in the ledger in sync with those figures:
 *
 *   • cash row — party "GOVERNMENT (GST)", `cashPaid`, on `cashAccountId`
 *     (or no account until the admin says which bank / card paid);
 *   • ITC row  — party "GOVERNMENT (GST)", `itcUsed`, never on an account.
 *
 * Both rows are dated `paidOn` (falling back to the 20th of the following
 * month, the GSTR-3B due date) and tagged to the first active product.
 * A zero amount removes the corresponding row. Deleting the return removes
 * both rows.
 */

import type { Prisma, PrismaClient } from '@prisma/client';

import { monthLabel } from '@/lib/finance';

export const GST_PARTY_NAME = 'GOVERNMENT (GST)';

type Tx = Prisma.TransactionClient;

export interface GstReturnFigures {
  month: string;
  itcUsed: number;
  cashPaid: number;
  paidOn: Date | null;
  cashAccountId: string | null;
  reference: string | null;
}

/** GSTR-3B due date for a `YYYY-MM` period: the 20th of the next month (UTC). */
export function defaultGstPaymentDate(month: string): Date {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 20)); // m is 1-based → next month is index m
}

/** Find-or-create the Government (GST) party. */
export async function ensureGstParty(db: Tx | PrismaClient, createdById: string): Promise<string> {
  const existing = await db.financeParty.findFirst({
    where: { name: GST_PARTY_NAME },
    select: { id: true },
  });
  if (existing) return existing.id;
  const created = await db.financeParty.create({
    data: { name: GST_PARTY_NAME, type: 'OTHER', createdById },
    select: { id: true },
  });
  return created.id;
}

async function firstActiveProductId(db: Tx | PrismaClient): Promise<string | null> {
  const p = await db.product.findFirst({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: { id: true },
  });
  return p?.id ?? null;
}

function cashDescription(f: GstReturnFigures): string {
  const total = Math.round((f.itcUsed + f.cashPaid) * 100) / 100;
  return `GST payment, ${monthLabel(f.month)} return — cash part (total ${total.toLocaleString('en-IN')})`;
}

function itcDescription(f: GstReturnFigures): string {
  const total = Math.round((f.itcUsed + f.cashPaid) * 100) / 100;
  return `GST payment, ${monthLabel(f.month)} return — set off against input tax credit, no cash paid (total ${total.toLocaleString('en-IN')})`;
}

/**
 * Create / update / remove the ledger rows for one return so they match
 * `figures`. Returns the (possibly new) row ids. Must run inside the same
 * transaction as the GstReturn write.
 */
export async function syncGstLedgerRows(
  tx: Tx,
  figures: GstReturnFigures,
  existing: { cashTransactionId: string | null; itcTransactionId: string | null },
  createdById: string,
): Promise<{ cashTransactionId: string | null; itcTransactionId: string | null }> {
  const partyId = await ensureGstParty(tx, createdById);
  const productId = await firstActiveProductId(tx);
  const date = figures.paidOn ?? defaultGstPaymentDate(figures.month);

  async function upsertRow(
    id: string | null,
    amount: number,
    description: string,
    accountId: string | null,
  ): Promise<string | null> {
    if (amount <= 0) {
      if (id) await tx.financeTransaction.deleteMany({ where: { id } });
      return null;
    }
    const data = {
      date,
      direction: 'OUT' as const,
      category: 'TAX' as const,
      amount,
      description,
      reference: figures.reference,
      partyId,
      accountId,
      productId,
    };
    if (id) {
      const found = await tx.financeTransaction.findUnique({ where: { id }, select: { id: true } });
      if (found) {
        await tx.financeTransaction.update({ where: { id }, data });
        return id;
      }
    }
    const created = await tx.financeTransaction.create({
      data: { ...data, createdById },
      select: { id: true },
    });
    return created.id;
  }

  const cashTransactionId = await upsertRow(
    existing.cashTransactionId,
    figures.cashPaid,
    cashDescription(figures),
    figures.cashAccountId,
  );
  const itcTransactionId = await upsertRow(
    existing.itcTransactionId,
    figures.itcUsed,
    itcDescription(figures),
    null,
  );
  return { cashTransactionId, itcTransactionId };
}

/** Remove the ledger rows a return created. */
export async function deleteGstLedgerRows(
  tx: Tx,
  ids: { cashTransactionId: string | null; itcTransactionId: string | null },
): Promise<void> {
  const list = [ids.cashTransactionId, ids.itcTransactionId].filter((v): v is string => Boolean(v));
  if (list.length > 0) {
    await tx.financeTransaction.deleteMany({ where: { id: { in: list } } });
  }
}

/**
 * Running input-tax-credit balance after each month, oldest first:
 * previous balance + claimed − used. Months are sorted by key so callers
 * can pass rows in any order.
 */
export function itcRunningBalances<T extends { month: string; itcClaimed: number; itcUsed: number }>(
  rows: readonly T[],
): Map<string, number> {
  const out = new Map<string, number>();
  let balance = 0;
  for (const r of [...rows].sort((a, b) => a.month.localeCompare(b.month))) {
    balance = Math.round((balance + r.itcClaimed - r.itcUsed) * 100) / 100;
    out.set(r.month, balance);
  }
  return out;
}

/** Per-head ITC position: what was claimed, used and what is left. */
export interface GstHeadPosition {
  claimed: number;
  used: number;
  balance: number;
}

export type GstHeadTotals = { igst: GstHeadPosition; cgst: GstHeadPosition; sgst: GstHeadPosition };

/**
 * ITC claimed / used / balance per tax head across the given returns.
 * Heads are kept separate because the credit ledger itself is: SGST credit
 * can never pay a CGST liability, and vice versa.
 */
export function itcByHead(
  rows: readonly {
    itcClaimedIgst: number; itcClaimedCgst: number; itcClaimedSgst: number;
    itcUsedIgst: number; itcUsedCgst: number; itcUsedSgst: number;
  }[],
): GstHeadTotals {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const build = (claimed: number, used: number): GstHeadPosition => ({
    claimed: r2(claimed),
    used: r2(used),
    balance: r2(claimed - used),
  });
  return {
    igst: build(
      rows.reduce((s, r) => s + r.itcClaimedIgst, 0),
      rows.reduce((s, r) => s + r.itcUsedIgst, 0),
    ),
    cgst: build(
      rows.reduce((s, r) => s + r.itcClaimedCgst, 0),
      rows.reduce((s, r) => s + r.itcUsedCgst, 0),
    ),
    sgst: build(
      rows.reduce((s, r) => s + r.itcClaimedSgst, 0),
      rows.reduce((s, r) => s + r.itcUsedSgst, 0),
    ),
  };
}
