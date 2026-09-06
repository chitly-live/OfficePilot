/**
 * Employee ↔ Finance glue (Prisma-backed).
 *
 *   • {@link ensureEmployeeParty} — every panel user who gets paid needs a
 *     `FinanceParty` (type EMPLOYEE, `userId` set). Created on first use,
 *     re-used afterwards, kept in sync with the user's name / contact.
 *   • {@link loadEmployeeSalary} — one employee's pay facts for their page:
 *     agreed amount, payments, per-month status.
 *   • {@link loadSalaryBoard} — all active employees with an agreed salary
 *     and what has been paid for a given month (Finance overview card).
 */

import type { PrismaClient } from '@prisma/client';

import { round2, shiftMonthKey, toMonthKey } from '@/lib/finance';
import {
  salaryPaidByMonth,
  salaryStatus,
  salaryTimeline,
  type MonthSalaryLine,
  type SalaryStatus,
} from '@/lib/salary';

export interface EmployeePartyRef {
  id: string;
  name: string;
  created: boolean;
}

/**
 * Find or create the Finance party for a user. Idempotent. Throws if the
 * user does not exist.
 */
export async function ensureEmployeeParty(
  db: PrismaClient,
  userId: string,
  actorId: string,
): Promise<EmployeePartyRef> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      financeParty: { select: { id: true, name: true } },
    },
  });
  if (!user) throw new Error('User not found');
  if (user.financeParty) {
    return { id: user.financeParty.id, name: user.financeParty.name, created: false };
  }
  const party = await db.financeParty.create({
    data: {
      name: user.name || user.email,
      type: 'EMPLOYEE',
      email: user.email,
      phone: user.phone,
      userId: user.id,
      createdById: actorId,
    },
    select: { id: true, name: true },
  });
  return { id: party.id, name: party.name, created: true };
}

export interface EmployeeSalaryPayment {
  id: string;
  date: Date;
  amount: number;
  description: string | null;
  reference: string | null;
  accountName: string | null;
}

export interface EmployeeSalary {
  partyId: string | null;
  monthlySalary: number | null;
  salaryLabel: string | null;
  totalPaid: number;
  payments: EmployeeSalaryPayment[];
  /** Newest first; from the join month (or 6 months back) to this month. */
  timeline: MonthSalaryLine[];
  currentMonth: string;
  currentStatus: SalaryStatus;
}

export async function loadEmployeeSalary(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<EmployeeSalary | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      monthlySalary: true,
      salaryLabel: true,
      joinedAt: true,
      financeParty: { select: { id: true } },
    },
  });
  if (!user) return null;

  const partyId = user.financeParty?.id ?? null;
  const rows = partyId
    ? await db.financeTransaction.findMany({
        where: { partyId, category: 'SALARY', direction: 'OUT' },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          date: true,
          amount: true,
          description: true,
          reference: true,
          account: { select: { name: true } },
        },
      })
    : [];

  const paidByMonth = salaryPaidByMonth(rows);
  const currentMonth = toMonthKey(now);
  const joinedMonth = toMonthKey(user.joinedAt);
  const from = joinedMonth > shiftMonthKey(currentMonth, -5) ? joinedMonth : shiftMonthKey(currentMonth, -5);

  return {
    partyId,
    monthlySalary: user.monthlySalary,
    salaryLabel: user.salaryLabel,
    totalPaid: round2(rows.reduce((s, r) => s + r.amount, 0)),
    payments: rows.map((r) => ({
      id: r.id,
      date: r.date,
      amount: r.amount,
      description: r.description,
      reference: r.reference,
      accountName: r.account?.name ?? null,
    })),
    timeline: salaryTimeline({
      expected: user.monthlySalary,
      paidByMonth,
      from,
      to: currentMonth,
      joinedMonth,
    }),
    currentMonth,
    currentStatus: salaryStatus(user.monthlySalary, paidByMonth.get(currentMonth) ?? 0),
  };
}

export interface SalaryBoardRow {
  userId: string;
  name: string;
  designation: string | null;
  partyId: string | null;
  monthlySalary: number;
  salaryLabel: string | null;
  paid: number;
  status: SalaryStatus;
}

export interface SalaryBoard {
  month: string;
  rows: SalaryBoardRow[];
  expectedTotal: number;
  paidTotal: number;
}

/** Every active user with an agreed salary, and what they got in `month`. */
export async function loadSalaryBoard(
  db: PrismaClient,
  month: string,
): Promise<SalaryBoard> {
  const users = await db.user.findMany({
    where: { isActive: true, monthlySalary: { gt: 0 } },
    select: {
      id: true,
      name: true,
      designation: true,
      monthlySalary: true,
      salaryLabel: true,
      financeParty: { select: { id: true } },
    },
    orderBy: [{ name: 'asc' }],
  });
  const partyIds = users.map((u) => u.financeParty?.id).filter((x): x is string => Boolean(x));
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 0, 23, 59, 59, 999));
  const paidRows = partyIds.length
    ? await db.financeTransaction.groupBy({
        by: ['partyId'],
        where: {
          partyId: { in: partyIds },
          category: 'SALARY',
          direction: 'OUT',
          date: { gte: from, lte: to },
        },
        _sum: { amount: true },
      })
    : [];
  const paidByParty = new Map(paidRows.map((r) => [r.partyId as string, r._sum.amount ?? 0]));

  const rows: SalaryBoardRow[] = users.map((u) => {
    const partyId = u.financeParty?.id ?? null;
    const paid = round2(partyId ? paidByParty.get(partyId) ?? 0 : 0);
    return {
      userId: u.id,
      name: u.name,
      designation: u.designation,
      partyId,
      monthlySalary: u.monthlySalary ?? 0,
      salaryLabel: u.salaryLabel,
      paid,
      status: salaryStatus(u.monthlySalary, paid),
    };
  });
  return {
    month,
    rows,
    expectedTotal: round2(rows.reduce((s, r) => s + r.monthlySalary, 0)),
    paidTotal: round2(rows.reduce((s, r) => s + r.paid, 0)),
  };
}
