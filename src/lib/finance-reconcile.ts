/**
 * Loads what the reconciler needs for one account and one statement, and
 * adds the balance checks: opening, closing, and the first day on which the
 * bank's running balance and the ledger's stop agreeing.
 */

import type { ParsedStatement, StatementLine } from '@/lib/bank-statement';
import { computeAccountBalance, round2, toDateKey, toMonthKey } from '@/lib/finance';
import type { FinanceDbClient } from '@/lib/finance-summary';
import { latestClosedMonth, monthEnd } from '@/lib/month-close';
import { reconcile, type LedgerLine, type ReconcileResult } from '@/lib/reconcile';

export interface DayMismatch {
  date: string;
  statement: number;
  ledger: number;
  difference: number;
}

export interface ReconciliationView extends ReconcileResult {
  account: { id: string; name: string };
  periodFrom: string;
  periodTo: string;
  statementLines: number;
  ledgerRows: number;
  opening: { statement: number | null; ledger: number };
  closing: { statement: number | null; ledger: number };
  /** Days whose closing balance differs, earliest first (empty = all agree). */
  dayMismatches: DayMismatch[];
  skipped: ParsedStatement['skipped'];
  /** Everything agrees: nothing missing, nothing extra, balances equal. */
  clean: boolean;
  /** The calendar month the statement covers exactly, if it does. */
  month: string | null;
  lockedThrough: string | null;
}

/**
 * Which way the file runs, read from the balance chain: in a newest-first
 * file each line's balance, with that line undone, is the next line's
 * balance. Dates alone cannot tell when every line falls on one day.
 */
export function isNewestFirst(lines: readonly StatementLine[]): boolean {
  let newest = 0;
  let oldest = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i]!;
    const b = lines[i + 1]!;
    if (a.balance === null || b.balance === null) continue;
    const sa = a.direction === 'IN' ? a.amount : -a.amount;
    const sb = b.direction === 'IN' ? b.amount : -b.amount;
    if (Math.abs(round2(a.balance - sa) - b.balance) < 0.01) newest++;
    if (Math.abs(round2(b.balance - sb) - a.balance) < 0.01) oldest++;
  }
  if (newest !== oldest) return newest > oldest;
  return lines.length > 1 && lines[0]!.date.getTime() > lines[lines.length - 1]!.date.getTime();
}

/** Day-end balance per date as the bank printed it. */
export function statementDayEnds(lines: readonly StatementLine[]): Map<string, number> {
  const withBalance = lines.filter((l) => l.balance !== null);
  if (withBalance.length === 0) return new Map();
  // The day's last line is the first one seen for that date in a
  // newest-first file, the last one seen otherwise.
  const newestFirst = isNewestFirst(withBalance);
  const out = new Map<string, number>();
  for (const l of withBalance) {
    const key = toDateKey(l.date);
    if (newestFirst ? !out.has(key) : true) out.set(key, l.balance!);
  }
  return out;
}

function exactMonth(from: Date, to: Date): string | null {
  const key = toMonthKey(from);
  if (from.getUTCDate() !== 1) return null;
  if (toMonthKey(to) !== key) return null;
  const end = monthEnd(key);
  return to.getUTCDate() === end.getUTCDate() ? key : null;
}

export async function loadReconciliation(
  db: FinanceDbClient,
  accountId: string,
  parsed: ParsedStatement,
): Promise<ReconciliationView | null> {
  const account = await db.financeAccount.findUnique({
    where: { id: accountId },
    select: { id: true, name: true, openingBalance: true },
  });
  if (!account) return null;

  const from = parsed.periodFrom!;
  const to = parsed.periodTo!;
  const toEnd = new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1);

  const select = {
    id: true,
    date: true,
    direction: true,
    amount: true,
    category: true,
    description: true,
    reference: true,
    partyId: true,
    viaPartyId: true,
    accountId: true,
    party: { select: { name: true } },
  } as const;

  const [accountRows, history, lockedThrough, parties] = await Promise.all([
    db.financeTransaction.findMany({
      where: { accountId, date: { lte: toEnd } },
      select,
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    }),
    db.financeTransaction.findMany({
      select,
      orderBy: { date: 'desc' },
      take: 1000,
    }),
    latestClosedMonth(db),
    db.financeParty.findMany({ where: { isActive: true }, select: { id: true, name: true } }),
  ]);

  const toLine = (r: (typeof accountRows)[number]): LedgerLine => ({
    id: r.id,
    date: r.date,
    direction: r.direction,
    amount: r.amount,
    category: r.category,
    description: r.description,
    reference: r.reference,
    partyId: r.partyId,
    partyName: r.party?.name ?? null,
    viaPartyId: r.viaPartyId,
  });

  const before = accountRows.filter((r) => r.date.getTime() < from.getTime());
  const inWindow = accountRows.filter((r) => r.date.getTime() >= from.getTime()).map(toLine);
  const result = reconcile(parsed.lines, inWindow, history.map(toLine), parties);

  const ledgerOpening = computeAccountBalance(account.openingBalance, before);
  const ledgerClosing = computeAccountBalance(ledgerOpening, inWindow);

  // Day-by-day: the ledger's running balance against the bank's.
  const bankDays = statementDayEnds(parsed.lines);
  const dayMismatches: DayMismatch[] = [];
  if (bankDays.size > 0) {
    const deltaByDay = new Map<string, number>();
    for (const r of inWindow) {
      const key = toDateKey(r.date);
      deltaByDay.set(key, (deltaByDay.get(key) ?? 0) + (r.direction === 'IN' ? r.amount : -r.amount));
    }
    const keys = Array.from(new Set([...bankDays.keys(), ...deltaByDay.keys()])).sort();
    let running = ledgerOpening;
    for (const key of keys) {
      running = round2(running + (deltaByDay.get(key) ?? 0));
      const bank = bankDays.get(key);
      if (bank === undefined) continue;
      const difference = round2(running - bank);
      if (Math.abs(difference) >= 0.01) {
        dayMismatches.push({ date: key, statement: bank, ledger: running, difference });
      }
    }
  }

  const openingOk = parsed.opening === null || Math.abs(parsed.opening - ledgerOpening) < 0.01;
  const closingOk = parsed.closing === null || Math.abs(parsed.closing - ledgerClosing) < 0.01;

  return {
    ...result,
    account: { id: account.id, name: account.name },
    periodFrom: toDateKey(from),
    periodTo: toDateKey(to),
    statementLines: parsed.lines.length,
    ledgerRows: inWindow.length,
    opening: { statement: parsed.opening, ledger: ledgerOpening },
    closing: { statement: parsed.closing, ledger: ledgerClosing },
    dayMismatches,
    skipped: parsed.skipped,
    clean:
      result.missing.length === 0 &&
      result.extra.length === 0 &&
      openingOk &&
      closingOk &&
      dayMismatches.length === 0,
    month: exactMonth(from, to),
    lockedThrough,
  };
}
