/**
 * Month close — freeze the ledger once a month has been checked against the
 * bank statement.
 *
 * Balances are cumulative: an edit in August moves September's closing
 * balance too. So a close works like an accounting "lock date": closing a
 * month locks it AND everything before it. Any write dated on or before the
 * end of the latest closed month is refused. Only the latest closed month can
 * be reopened, which moves the lock date back one month at a time.
 *
 * Each close records every account's balance at that month end. Comparing
 * those with what the ledger computes today (`findDrift`) catches any change
 * that slipped past the lock — a direct database fix, for instance.
 */

import type { PrismaClient } from '@prisma/client';

import { BadRequestError, ConflictError } from '@/lib/http-errors';
import {
  computeAccountBalance,
  monthLabel,
  monthRange,
  round2,
  shiftMonthKey,
  toMonthKey,
} from '@/lib/finance';
import type { FinanceDbClient } from '@/lib/finance-summary';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_RE.test(value);
}

/** Last instant of a YYYY-MM month (UTC). */
export function monthEnd(month: string): Date {
  const range = monthRange(month);
  if (!range) throw new BadRequestError('Month must look like YYYY-MM');
  return range.to;
}

// ---------------------------------------------------------------------------
// Lock checks
// ---------------------------------------------------------------------------

/** The latest closed month, or null when nothing is closed. */
export async function latestClosedMonth(db: FinanceDbClient): Promise<string | null> {
  const row = await db.monthClose.findFirst({
    orderBy: { month: 'desc' },
    select: { month: true },
  });
  return row?.month ?? null;
}

/** True when `date` falls on or before the end of `lockedThrough`. */
export function isLocked(date: Date, lockedThrough: string | null): boolean {
  if (!lockedThrough) return false;
  return date.getTime() <= monthEnd(lockedThrough).getTime();
}

/**
 * Refuse a write that touches a locked date. Pass every date the write
 * affects — for an edit, both the old date and the new one, since moving a
 * row out of a closed month changes that month just as much.
 */
export async function assertDatesOpen(
  db: FinanceDbClient,
  dates: readonly (Date | null | undefined)[],
): Promise<void> {
  const real = dates.filter(
    (d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()),
  );
  if (real.length === 0) return;
  const lockedThrough = await latestClosedMonth(db);
  if (!lockedThrough) return;
  const hit = real.filter((d) => isLocked(d, lockedThrough));
  if (hit.length === 0) return;
  const months = Array.from(new Set(hit.map(toMonthKey))).sort();
  throw new ConflictError(
    'month_closed',
    `${months.map(monthLabel).join(', ')} is closed — the books are locked up to the end of ${monthLabel(lockedThrough)}. Reopen it on the Close page first.`,
    { months, lockedThrough },
  );
}

/**
 * Opening balances sit before every row, so changing one moves every closed
 * balance. Refuse while anything is closed.
 */
export async function assertNoClosedMonths(db: FinanceDbClient, what: string): Promise<void> {
  const lockedThrough = await latestClosedMonth(db);
  if (!lockedThrough) return;
  throw new ConflictError(
    'month_closed',
    `${what} would change balances in closed months (locked up to ${monthLabel(lockedThrough)}). Reopen the months first.`,
    { lockedThrough },
  );
}

// ---------------------------------------------------------------------------
// Balances + drift (pure)
// ---------------------------------------------------------------------------

export interface ClosingAccount {
  id: string;
  openingBalance: number;
}

export interface ClosingRow {
  accountId: string | null;
  date: Date;
  direction: 'IN' | 'OUT';
  amount: number;
}

/** Every account's balance at the end of `month`: opening + ΣIN − ΣOUT up to then. */
export function closingBalances(
  accounts: readonly ClosingAccount[],
  rows: readonly ClosingRow[],
  month: string,
): Map<string, number> {
  const end = monthEnd(month).getTime();
  const byAccount = new Map<string, ClosingRow[]>();
  for (const r of rows) {
    if (!r.accountId || r.date.getTime() > end) continue;
    const list = byAccount.get(r.accountId) ?? [];
    list.push(r);
    byAccount.set(r.accountId, list);
  }
  const out = new Map<string, number>();
  for (const a of accounts) {
    out.set(a.id, computeAccountBalance(a.openingBalance, byAccount.get(a.id) ?? []));
  }
  return out;
}

export interface MonthDrift {
  accountId: string;
  accountName: string;
  recorded: number;
  now: number;
  difference: number;
}

/** Accounts whose balance today differs from the one recorded at close. */
export function findDrift(
  recorded: readonly { accountId: string; accountName: string; balance: number }[],
  current: ReadonlyMap<string, number>,
): MonthDrift[] {
  const out: MonthDrift[] = [];
  for (const r of recorded) {
    const now = current.get(r.accountId) ?? 0;
    const difference = round2(now - r.balance);
    if (Math.abs(difference) >= 0.01) {
      out.push({
        accountId: r.accountId,
        accountName: r.accountName,
        recorded: round2(r.balance),
        now: round2(now),
        difference,
      });
    }
  }
  return out;
}

/**
 * Months to record when closing through `target`: every month after the
 * current lock (or from the first ledger month) up to `target`, in order.
 */
export function monthsToClose(
  target: string,
  lockedThrough: string | null,
  firstLedgerMonth: string | null,
): string[] {
  const start = lockedThrough
    ? shiftMonthKey(lockedThrough, 1)
    : (firstLedgerMonth !== null && firstLedgerMonth < target ? firstLedgerMonth : target);
  if (start > target) return [];
  const out: string[] = [];
  for (let m = start; m <= target; m = shiftMonthKey(m, 1)) out.push(m);
  return out;
}

/** The month a close would normally target: the last month that has ended. */
export function lastEndedMonth(now: Date = new Date()): string {
  return shiftMonthKey(toMonthKey(now), -1);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

async function loadClosingInputs(db: FinanceDbClient) {
  const [accounts, rows] = await Promise.all([
    db.financeAccount.findMany({ select: { id: true, name: true, openingBalance: true } }),
    db.financeTransaction.findMany({
      where: { accountId: { not: null } },
      select: { accountId: true, date: true, direction: true, amount: true },
    }),
  ]);
  return { accounts, rows };
}

/**
 * Close every open month up to and including `target`. The month must be
 * over — a month still running cannot have been checked against a statement.
 */
export async function closeThrough(
  db: PrismaClient,
  target: string,
  userId: string,
  note: string | null,
  now: Date = new Date(),
): Promise<string[]> {
  if (!isMonthKey(target)) throw new BadRequestError('Month must look like YYYY-MM');
  if (monthEnd(target).getTime() >= now.getTime()) {
    throw new BadRequestError(
      `${monthLabel(target)} is not over yet — close it once the month has ended.`,
    );
  }

  return db.$transaction(async (tx) => {
    const lockedThrough = await latestClosedMonth(tx);
    if (lockedThrough && lockedThrough >= target) {
      throw new ConflictError('already_closed', `${monthLabel(target)} is already closed.`, {
        lockedThrough,
      });
    }
    const first = await tx.financeTransaction.findFirst({
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    const months = monthsToClose(target, lockedThrough, first ? toMonthKey(first.date) : null);
    const { accounts, rows } = await loadClosingInputs(tx);

    for (const month of months) {
      const balances = closingBalances(accounts, rows, month);
      await tx.monthClose.create({
        data: {
          month,
          closedById: userId,
          note: month === target ? note : null,
          balances: {
            create: accounts.map((a) => ({ accountId: a.id, balance: balances.get(a.id) ?? 0 })),
          },
        },
      });
    }
    return months;
  });
}

/** Reopen the latest closed month. Earlier months need later ones reopened first. */
export async function reopenMonth(db: PrismaClient, month: string): Promise<void> {
  if (!isMonthKey(month)) throw new BadRequestError('Month must look like YYYY-MM');
  await db.$transaction(async (tx) => {
    const latest = await latestClosedMonth(tx);
    if (!latest || latest < month) {
      throw new ConflictError('not_closed', `${monthLabel(month)} is not closed.`);
    }
    if (latest !== month) {
      throw new ConflictError(
        'reopen_order',
        `Reopen ${monthLabel(latest)} first — months reopen newest first, because each one's balance builds on the one before.`,
        { latest },
      );
    }
    await tx.monthClose.delete({ where: { month } });
  });
}

// ---------------------------------------------------------------------------
// Read model for the Close page
// ---------------------------------------------------------------------------

export interface MonthCloseStatus {
  month: string;
  closedAt: Date;
  closedBy: string;
  note: string | null;
  balances: { accountId: string; accountName: string; balance: number }[];
  drift: MonthDrift[];
}

export async function loadMonthCloses(db: FinanceDbClient): Promise<MonthCloseStatus[]> {
  const [closes, inputs] = await Promise.all([
    db.monthClose.findMany({
      orderBy: { month: 'desc' },
      select: {
        month: true,
        closedAt: true,
        note: true,
        closedBy: { select: { name: true } },
        balances: {
          select: { accountId: true, balance: true, account: { select: { name: true } } },
        },
      },
    }),
    loadClosingInputs(db),
  ]);
  return closes.map((c) => {
    const recorded = c.balances.map((b) => ({
      accountId: b.accountId,
      accountName: b.account.name,
      balance: b.balance,
    }));
    return {
      month: c.month,
      closedAt: c.closedAt,
      closedBy: c.closedBy.name,
      note: c.note,
      balances: recorded.sort((a, b) => a.accountName.localeCompare(b.accountName)),
      drift: findDrift(recorded, closingBalances(inputs.accounts, inputs.rows, c.month)),
    };
  });
}
