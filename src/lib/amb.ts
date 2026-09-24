/**
 * Average Monthly Balance (AMB) for a bank account.
 *
 * Indian banks work out the AMB by taking the *closing balance of every
 * single day* in the month — weekends and holidays included, each one
 * carrying the previous working day's balance — adding them up and
 * dividing by the number of days in the month. Fall below the required
 * figure and the bank charges a non-maintenance fee plus GST.
 *
 * Mid-month the average so far is only part of the story, so this module
 * also answers the question that actually matters: what balance must sit
 * in the account for the rest of the month to still land on target.
 *
 * Pure functions — no DB, no clock. Callers pass the rows and "today".
 */

export interface AmbRow {
  /** UTC date of the transaction. */
  date: Date;
  direction: 'IN' | 'OUT';
  amount: number;
}

export interface AmbDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** Closing balance that day. */
  balance: number;
}

export interface AmbResult {
  /** `YYYY-MM`. */
  month: string;
  daysInMonth: number;
  /** Days already closed (up to and including `today`). */
  daysCounted: number;
  daysRemaining: number;
  /** Average of the closing balances so far. */
  averageSoFar: number;
  /** Required average, from the account settings. */
  required: number;
  /**
   * Balance needed every remaining day to finish the month on target.
   * `0` when the target is already secured, `null` when the month is over.
   */
  neededDailyBalance: number | null;
  /** Projected month-end average if the balance never changes again. */
  projectedAverage: number;
  /** How far the projection falls short (0 when on / above target). */
  projectedShortfall: number;
  /** Closing balance on `today`. */
  closingBalance: number;
  /** Per-day closing balances up to `today`. */
  days: AmbDay[];
  status: AmbStatus;
}

export type AmbStatus = 'ON_TRACK' | 'AT_RISK' | 'SHORT' | 'NOT_SET' | 'DONE_OK' | 'DONE_SHORT';

export const AMB_STATUS_LABELS: Record<AmbStatus, string> = {
  ON_TRACK: 'On track',
  AT_RISK: 'Needs a top-up',
  SHORT: 'Cannot recover',
  NOT_SET: 'Not set',
  DONE_OK: 'Met',
  DONE_SHORT: 'Missed',
};

const r2 = (n: number) => Math.round(n * 100) / 100;

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Days in a `YYYY-MM` month (UTC). */
export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Closing balance for every day from the 1st of `month` up to `throughDay`
 * (1-based). A day with no transactions repeats the previous day's balance,
 * which is exactly how the bank counts it.
 */
export function dailyClosingBalances(
  openingBalance: number,
  rows: readonly AmbRow[],
  month: string,
  throughDay: number,
): AmbDay[] {
  const [y, m] = month.split('-').map(Number);
  const monthStart = Date.UTC(y, m - 1, 1);

  // Everything before the month forms the opening balance for day 1.
  let balance = openingBalance;
  const perDay = new Map<number, number>();
  for (const row of rows) {
    const t = row.date.getTime();
    const delta = row.direction === 'IN' ? row.amount : -row.amount;
    if (t < monthStart) {
      balance += delta;
      continue;
    }
    const d = new Date(t);
    if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1) continue;
    const day = d.getUTCDate();
    perDay.set(day, (perDay.get(day) ?? 0) + delta);
  }

  const out: AmbDay[] = [];
  const last = Math.min(Math.max(throughDay, 0), daysInMonth(month));
  for (let day = 1; day <= last; day += 1) {
    balance += perDay.get(day) ?? 0;
    out.push({ date: `${y}-${pad(m)}-${pad(day)}`, balance: r2(balance) });
  }
  return out;
}

export interface ComputeAmbInput {
  openingBalance: number;
  rows: readonly AmbRow[];
  month: string;
  /** Required average; `null` / `0` means the account has no AMB rule. */
  required: number | null | undefined;
  /** Day of the month already closed. Pass `daysInMonth` for a past month. */
  throughDay: number;
}

export function computeAmb(input: ComputeAmbInput): AmbResult {
  const total = daysInMonth(input.month);
  const throughDay = Math.min(Math.max(input.throughDay, 0), total);
  const days = dailyClosingBalances(input.openingBalance, input.rows, input.month, throughDay);
  const sum = days.reduce((s, d) => s + d.balance, 0);
  const daysCounted = days.length;
  const daysRemaining = total - daysCounted;
  const closingBalance = days.length > 0 ? days[days.length - 1].balance : r2(input.openingBalance);
  const required = input.required ?? 0;

  const averageSoFar = daysCounted > 0 ? r2(sum / daysCounted) : 0;
  // If the balance never moves again, this is where the month lands.
  const projectedAverage = total > 0 ? r2((sum + closingBalance * daysRemaining) / total) : 0;

  let neededDailyBalance: number | null = null;
  if (required > 0 && daysRemaining > 0) {
    neededDailyBalance = r2(Math.max(0, (required * total - sum) / daysRemaining));
  }

  let status: AmbStatus;
  if (required <= 0) {
    status = 'NOT_SET';
  } else if (daysRemaining === 0) {
    status = averageSoFar >= required ? 'DONE_OK' : 'DONE_SHORT';
  } else if (projectedAverage >= required) {
    status = 'ON_TRACK';
  } else if (neededDailyBalance !== null && neededDailyBalance > 0) {
    // Nothing can rescue a month whose remaining days cannot carry enough.
    status = 'AT_RISK';
  } else {
    status = 'SHORT';
  }
  // A month where even an infinite balance can't help: the shortfall is so
  // large that the required daily figure is unreachable in practice. We keep
  // AT_RISK (the owner can still add funds) and let the number speak.

  return {
    month: input.month,
    daysInMonth: total,
    daysCounted,
    daysRemaining,
    averageSoFar,
    required: r2(required),
    neededDailyBalance,
    projectedAverage,
    projectedShortfall: required > 0 ? r2(Math.max(0, required - projectedAverage)) : 0,
    closingBalance,
    days,
    status,
  };
}
