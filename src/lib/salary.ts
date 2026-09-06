/**
 * Salary / stipend helpers — pure, no I/O.
 *
 * An employee (`User`) can carry `monthlySalary` + `salaryLabel`. Payouts are
 * ordinary Finance transactions with category `SALARY` against the party
 * linked to that user (`FinanceParty.userId`). These helpers turn the raw
 * rows into "paid ₹X of ₹Y for August" style facts for the UI.
 */

import { round2, toMonthKey } from '@/lib/finance';

export type SalaryStatus = 'PAID' | 'PARTIAL' | 'PENDING' | 'NOT_SET';

export interface SalaryPaymentRow {
  date: Date;
  amount: number;
}

/** Sum of salary paid per `'YYYY-MM'` month (by payment date). */
export function salaryPaidByMonth(
  rows: readonly SalaryPaymentRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const amount = Number.isFinite(r.amount) ? r.amount : 0;
    const key = toMonthKey(r.date);
    out.set(key, round2((out.get(key) ?? 0) + amount));
  }
  return out;
}

/**
 * Status for one month given the agreed amount and what was actually paid.
 * A small rounding tolerance (₹1) keeps "₹4,999.60" from reading as partial.
 */
export function salaryStatus(
  expected: number | null | undefined,
  paid: number,
): SalaryStatus {
  if (expected === null || expected === undefined || expected <= 0) return 'NOT_SET';
  if (paid <= 0) return 'PENDING';
  if (paid + 1 >= expected) return 'PAID';
  return 'PARTIAL';
}

export const SALARY_STATUS_LABELS: Record<SalaryStatus, string> = {
  PAID: 'Paid',
  PARTIAL: 'Partly paid',
  PENDING: 'Pending',
  NOT_SET: 'No salary set',
};

export interface MonthSalaryLine {
  month: string;
  expected: number | null;
  paid: number;
  status: SalaryStatus;
}

/**
 * One line per month from `from` to `to` (inclusive, `'YYYY-MM'` keys),
 * newest first. Months before the employee joined are skipped when
 * `joinedMonth` is given.
 */
export function salaryTimeline(input: {
  expected: number | null | undefined;
  paidByMonth: Map<string, number>;
  from: string;
  to: string;
  joinedMonth?: string | null;
}): MonthSalaryLine[] {
  const lines: MonthSalaryLine[] = [];
  const [fy, fm] = input.from.split('-').map(Number);
  const [ty, tm] = input.to.split('-').map(Number);
  if (!fy || !fm || !ty || !tm) return lines;
  let y = fy;
  let m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!input.joinedMonth || key >= input.joinedMonth) {
      const paid = input.paidByMonth.get(key) ?? 0;
      lines.push({
        month: key,
        expected: input.expected ?? null,
        paid,
        status: salaryStatus(input.expected, paid),
      });
    }
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return lines.reverse();
}
