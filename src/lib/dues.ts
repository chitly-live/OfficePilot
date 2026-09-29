/**
 * "What has to be paid, and by when" — one list built from everything the
 * panel already knows:
 *
 *   • credit-card bills already generated (statement → due date → unpaid)
 *   • the monthly GST return (due the 20th of the next month)
 *   • salaries not yet paid this month
 *   • domains / subscriptions renewing within 30 days
 *   • a bank account whose average monthly balance is at risk
 *   • loans taken with a due date
 *
 * plus the money position: cash in our accounts against what we owe.
 */

import type { PrismaClient } from '@prisma/client';

import { renewalState } from '@/lib/assets';
import { computeCardPosition, lastStatement, statementBill } from '@/lib/credit-card';
import {
  computeAccountBalance,
  computePartyBalance,
  formatDateUtc,
  formatInr,
  monthLabel,
  round2,
  shiftMonthKey,
  summarizeRows,
  toMonthKey,
} from '@/lib/finance';
import { loadAccountAmb } from '@/lib/finance-amb';
import { cardLedgerRows } from '@/lib/finance-cards';
import { loadSalaryBoard } from '@/lib/finance-employee';
import { defaultGstPaymentDate } from '@/lib/gst';

const DAY_MS = 24 * 60 * 60 * 1000;
const SOON_DAYS = 7;

export type DueKind = 'CARD_BILL' | 'GST' | 'SALARY' | 'RENEWAL' | 'AMB' | 'LOAN';
export type DueStatus = 'OVERDUE' | 'DUE_SOON' | 'UPCOMING' | 'DONE';

export interface DueItem {
  key: string;
  kind: DueKind;
  title: string;
  detail: string;
  /** Still to pay; null when the panel cannot know (e.g. a GST return not filed yet). */
  amount: number | null;
  dueDate: Date | null;
  status: DueStatus;
  /** Label for DONE items ("Paid", "On track"). */
  doneLabel?: string;
  href: string | null;
}

export const DUE_KIND_LABELS: Record<DueKind, string> = {
  CARD_BILL: 'Card bill',
  GST: 'GST',
  SALARY: 'Salary',
  RENEWAL: 'Renewal',
  AMB: 'Bank balance',
  LOAN: 'Loan',
};

function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Status of something due on `due` that is (not) settled, seen from `today`. */
export function dueStatus(due: Date | null, settled: boolean, today: Date): DueStatus {
  if (settled) return 'DONE';
  if (!due) return 'UPCOMING';
  const days = Math.round((utcDay(due) - utcDay(today)) / DAY_MS);
  if (days < 0) return 'OVERDUE';
  if (days <= SOON_DAYS) return 'DUE_SOON';
  return 'UPCOMING';
}

const STATUS_ORDER: Record<DueStatus, number> = { OVERDUE: 0, DUE_SOON: 1, UPCOMING: 2, DONE: 3 };

export function sortDues(items: DueItem[]): DueItem[] {
  return [...items].sort(
    (a, b) =>
      STATUS_ORDER[a.status] - STATUS_ORDER[b.status] ||
      (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity) ||
      a.title.localeCompare(b.title),
  );
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

async function cardBills(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const cards = await db.financeAccount.findMany({
    where: { type: 'CREDIT_CARD', isActive: true, billingDay: { not: null } },
    select: { id: true, name: true, billingDay: true, dueDay: true },
  });
  if (cards.length === 0) return [];
  const ids = cards.map((c) => c.id);
  const rows = await db.financeTransaction.findMany({
    where: {
      OR: [
        { accountId: { in: ids } },
        { settlesAccountId: { in: ids } },
        { cardAllocations: { some: { accountId: { in: ids } } } },
      ],
    },
    select: {
      date: true,
      direction: true,
      amount: true,
      accountId: true,
      settlesAccountId: true,
      cardAllocations: { select: { accountId: true, amount: true } },
    },
  });

  const out: DueItem[] = [];
  for (const card of cards) {
    const { statementDate, dueDate } = lastStatement(card.billingDay!, today, card.dueDay);
    const bill = statementBill(cardLedgerRows(card.id, rows), statementDate, today);
    if (bill.billed <= 0) continue;
    const settled = bill.remaining <= 0;
    out.push({
      key: `card-${card.id}-${statementDate.toISOString().slice(0, 10)}`,
      kind: 'CARD_BILL',
      title: `${card.name.replace(/-CREDIT-CARD$/i, '').replace(/-/g, ' ')} — ${formatDateUtc(statementDate)} bill`,
      detail: settled
        ? `Bill ${formatInr(bill.billed)} fully paid.`
        : bill.paidSince > 0
          ? `Bill ${formatInr(bill.billed)}, ${formatInr(bill.paidSince)} paid since.`
          : `Bill ${formatInr(bill.billed)}, nothing paid towards it yet.`,
      amount: settled ? 0 : bill.remaining,
      dueDate,
      status: dueStatus(dueDate, settled, today),
      doneLabel: 'Paid',
      href: '/finance/accounts',
    });
  }
  return out;
}

async function gstDues(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const [first, returns] = await Promise.all([
    db.financeTransaction.findFirst({ orderBy: { date: 'asc' }, select: { date: true } }),
    db.gstReturn.findMany({ select: { month: true, cashPaid: true, itcUsed: true, itcClaimed: true, paidOn: true } }),
  ]);
  if (!first) return [];
  const filed = new Map(returns.map((r) => [r.month, r]));
  const current = toMonthKey(today);
  const out: DueItem[] = [];
  for (let m = toMonthKey(first.date); m <= current; m = shiftMonthKey(m, 1)) {
    const due = defaultGstPaymentDate(m);
    const r = filed.get(m);
    if (r) {
      // Only the latest filed return is worth showing as done.
      if (shiftMonthKey(m, 2) < current) continue;
      const incomplete = r.itcUsed > 0 && r.itcClaimed <= 0;
      out.push({
        key: `gst-${m}`,
        kind: 'GST',
        title: `GST return — ${monthLabel(m)}`,
        detail: incomplete
          ? `Filed: ${formatInr(r.itcUsed)} set off from ITC, ${formatInr(r.cashPaid)} cash. ITC claimed is not entered yet — the ITC balance is wrong until it is.`
          : `Filed: ${formatInr(r.itcUsed)} set off from ITC, ${formatInr(r.cashPaid)} cash.`,
        amount: 0,
        // Filed already; what is missing is data, so no deadline to show.
        dueDate: incomplete ? null : due,
        status: incomplete ? 'DUE_SOON' : 'DONE',
        doneLabel: 'Filed',
        href: '/finance/gst',
      });
      continue;
    }
    out.push({
      key: `gst-${m}`,
      kind: 'GST',
      title: `GST return — ${monthLabel(m)}`,
      detail: m === current ? 'Month still running — the accountant files it next month.' : 'Not entered yet. The accountant fills ITC and cash on the GST page.',
      amount: null,
      dueDate: due,
      status: dueStatus(due, false, today),
      href: '/finance/gst',
    });
  }
  return out;
}

async function salaryDues(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const month = toMonthKey(today);
  const board = await loadSalaryBoard(db, month);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  return board.rows
    .filter((r) => r.monthlySalary > 0 && (r.status === 'PENDING' || r.status === 'PARTIAL'))
    .map((r) => ({
      key: `salary-${r.userId}-${month}`,
      kind: 'SALARY' as const,
      title: `${r.salaryLabel ?? 'Salary'} — ${r.name}`,
      detail:
        r.paid > 0
          ? `${formatInr(r.paid)} of ${formatInr(r.monthlySalary)} paid for ${monthLabel(month)}.`
          : `${formatInr(r.monthlySalary)} for ${monthLabel(month)}.`,
      amount: round2(r.monthlySalary - r.paid),
      dueDate: end,
      status: dueStatus(end, false, today),
      href: r.partyId ? `/finance/parties/${r.partyId}` : null,
    }));
}

async function renewalDues(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const assets = await db.asset.findMany({
    where: { renewsOn: { not: null }, status: { notIn: ['SOLD', 'SCRAPPED'] } },
    select: { id: true, name: true, renewsOn: true, cost: true },
  });
  return assets
    .filter((a) => {
      const r = renewalState(a.renewsOn, today);
      return r === 'soon' || r === 'overdue';
    })
    .map((a) => ({
      key: `renew-${a.id}`,
      kind: 'RENEWAL' as const,
      title: `Renew ${a.name}`,
      detail: a.cost != null ? `Last paid ${formatInr(a.cost)}.` : 'Renewal date from the asset register.',
      amount: a.cost,
      dueDate: a.renewsOn,
      status: dueStatus(a.renewsOn, false, today),
      href: `/finance/assets/${a.id}`,
    }));
}

async function ambDues(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const month = toMonthKey(today);
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
  const list = await loadAccountAmb(db, month, today);
  return list
    .filter((a) => a.status !== 'NOT_SET')
    .map((a) => {
      const risk = a.status === 'AT_RISK' || a.status === 'SHORT' || a.status === 'DONE_SHORT';
      return {
        key: `amb-${a.accountId}-${month}`,
        kind: 'AMB' as const,
        title: `${a.accountName} — average monthly balance`,
        detail: risk
          ? `Average so far ${formatInr(a.averageSoFar)} against ${formatInr(a.required ?? 0)}. Keep ${formatInr(a.neededDailyBalance)} in the account every day to the month end to avoid the charge.`
          : `Average so far ${formatInr(a.averageSoFar)}, heading for ${formatInr(a.projectedAverage)} against ${formatInr(a.required ?? 0)} needed.`,
        amount: risk ? a.neededDailyBalance : null,
        dueDate: end,
        status: risk ? dueStatus(end, false, today) : ('DONE' as const),
        doneLabel: 'On track',
        href: '/finance/accounts',
      };
    });
}

/**
 * What is still owed on each loan from one lender: repayments clear the
 * oldest loan first. The remainders add up to the lender's outstanding, so
 * no rupee is shown twice and a repaid loan never comes back.
 */
export function allocateLoanRepayments<T extends { date: Date; amount: number }>(
  loans: readonly T[],
  repaid: number,
): (T & { remaining: number })[] {
  let left = Math.max(0, repaid);
  return [...loans]
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .map((loan) => {
      const used = Math.min(left, loan.amount);
      left = round2(left - used);
      return { ...loan, remaining: round2(loan.amount - used) };
    });
}

async function loanDues(db: PrismaClient, today: Date): Promise<DueItem[]> {
  const dated = await db.financeTransaction.findMany({
    where: { category: 'LOAN_RECEIVED', dueDate: { not: null }, partyId: { not: null } },
    select: { partyId: true },
  });
  const partyIds = Array.from(new Set(dated.map((l) => l.partyId!)));
  if (partyIds.length === 0) return [];
  const rows = await db.financeTransaction.findMany({
    where: { partyId: { in: partyIds }, category: { in: ['LOAN_RECEIVED', 'LOAN_REPAYMENT'] } },
    select: {
      id: true,
      date: true,
      category: true,
      amount: true,
      dueDate: true,
      partyId: true,
      party: { select: { name: true } },
    },
  });

  const out: DueItem[] = [];
  for (const partyId of partyIds) {
    const mine = rows.filter((r) => r.partyId === partyId);
    const repaid = mine.filter((r) => r.category === 'LOAN_REPAYMENT').reduce((s, r) => s + r.amount, 0);
    const loans = allocateLoanRepayments(
      mine.filter((r) => r.category === 'LOAN_RECEIVED'),
      repaid,
    );
    for (const l of loans) {
      if (!l.dueDate || l.remaining < 0.01) continue;
      out.push({
        key: `loan-${l.id}`,
        kind: 'LOAN',
        title: `Repay ${l.party?.name ?? 'loan'}`,
        detail:
          l.remaining < l.amount
            ? `Loan of ${formatInr(l.amount)} taken ${formatDateUtc(l.date)}; ${formatInr(round2(l.amount - l.remaining))} repaid.`
            : `Loan of ${formatInr(l.amount)} taken ${formatDateUtc(l.date)}.`,
        amount: l.remaining,
        dueDate: l.dueDate,
        status: dueStatus(l.dueDate, false, today),
        href: `/finance/parties/${partyId}`,
      });
    }
  }
  return out;
}

export async function loadDues(db: PrismaClient, today: Date = new Date()): Promise<DueItem[]> {
  const groups = await Promise.all([
    cardBills(db, today),
    gstDues(db, today),
    salaryDues(db, today),
    renewalDues(db, today),
    ambDues(db, today),
    loanDues(db, today),
  ]);
  return sortDues(groups.flat());
}

// ---------------------------------------------------------------------------
// Position
// ---------------------------------------------------------------------------

export interface MoneyPosition {
  /** Balance of every account of ours (not a borrowed card). */
  cash: number;
  cashAccounts: { id: string; name: string; balance: number }[];
  /** Everything we owe parties: card spend not yet repaid + loans. */
  owed: number;
  /** Who / what we owe; `href` is the page that explains the figure. */
  owedTo: { partyId: string; name: string; owed: number; href: string }[];
  /** cash − owed. Negative = we owe more than we hold. */
  net: number;
  /** Operating income / expense for the last three months (oldest first). */
  months: { month: string; income: number; expense: number; net: number; complete: boolean }[];
}

export async function loadPosition(db: PrismaClient, today: Date = new Date()): Promise<MoneyPosition> {
  const [accounts, rows, parties] = await Promise.all([
    db.financeAccount.findMany({
      select: { id: true, name: true, type: true, openingBalance: true, ownerPartyId: true, isActive: true },
    }),
    db.financeTransaction.findMany({
      select: {
        date: true,
        direction: true,
        category: true,
        amount: true,
        partyId: true,
        accountId: true,
        settlesAccountId: true,
        cardAllocations: { select: { accountId: true, amount: true } },
        account: { select: { ownerPartyId: true } },
      },
    }),
    db.financeParty.findMany({ select: { id: true, name: true } }),
  ]);

  const ours = accounts.filter((a) => a.type !== 'CREDIT_CARD' && !a.ownerPartyId);
  const cashAccounts = ours
    .map((a) => ({
      id: a.id,
      name: a.name,
      balance: computeAccountBalance(
        a.openingBalance,
        rows.filter((r) => r.accountId === a.id),
      ),
    }))
    .filter((a) => Math.abs(a.balance) >= 0.01 || accounts.find((x) => x.id === a.id)?.isActive);
  const cash = round2(cashAccounts.reduce((s, a) => s + a.balance, 0));

  const ledger = rows.map((r) => ({
    date: r.date,
    direction: r.direction,
    category: r.category,
    amount: r.amount,
    partyId: r.partyId,
    accountOwnerPartyId: r.account?.ownerPartyId ?? null,
  }));
  const owedTo = parties
    .map((p) => ({
      partyId: p.id,
      name: p.name,
      owed: computePartyBalance(ledger, p.id).owed,
      href: `/finance/parties/${p.id}`,
    }))
    .filter((p) => p.owed > 0);
  // A card nobody lent us (a company card) is owed to the bank itself; it
  // is not in any party's balance, so count its outstanding here.
  for (const card of accounts.filter((a) => a.type === 'CREDIT_CARD' && !a.ownerPartyId)) {
    const outstanding = computeCardPosition(cardLedgerRows(card.id, rows), null).outstanding;
    if (outstanding > 0) {
      owedTo.push({ partyId: `card:${card.id}`, name: card.name, owed: outstanding, href: '/finance/accounts' });
    }
  }
  owedTo.sort((a, b) => b.owed - a.owed);
  const owed = round2(owedTo.reduce((s, p) => s + p.owed, 0));

  // Last three months, but never before the ledger starts.
  const first = rows.reduce<Date | null>((min, r) => (!min || r.date < min ? r.date : min), null);
  const firstMonth = first ? toMonthKey(first) : toMonthKey(today);
  const current = toMonthKey(today);
  const months = [-2, -1, 0]
    .map((delta) => ({ delta, month: shiftMonthKey(current, delta) }))
    .filter(({ month }) => month >= firstMonth)
    .map(({ delta, month }) => {
      const t = summarizeRows(ledger.filter((r) => toMonthKey(r.date) === month));
      return { month, income: t.income, expense: t.expense, net: t.net, complete: delta < 0 };
    });

  return { cash, cashAccounts, owed, owedTo, net: round2(cash - owed), months };
}
