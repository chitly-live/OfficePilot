/**
 * Credit-card helpers — pure, no I/O.
 *
 * A borrowed credit card is a `FinanceAccount` of type CREDIT_CARD with an
 * optional `creditLimit`, `billingDay` (statement generation day) and
 * `dueDay` (payment due day, first occurrence after the statement).
 *
 *   outstanding = Σ spend on the card − Σ refunds into the card
 *               − Σ CARD_REPAYMENT rows that `settle` this card
 *   available   = creditLimit − outstanding
 *
 * The card owner's "we owe" balance is a separate, party-level number
 * (see `computePartyBalance`); this file only answers "how full is this
 * card and when is its bill due".
 */

import { round2 } from '@/lib/finance';

// ---------------------------------------------------------------------------
// Billing cycle maths (UTC calendar days)
// ---------------------------------------------------------------------------

export interface BillingCycle {
  /** First day of the cycle = last month's statement day (UTC midnight). */
  from: Date;
  /** Last day of the cycle = the day before the statement (UTC midnight). */
  to: Date;
  /** Day the statement for this cycle is generated (UTC midnight). */
  statementDate: Date;
  /** Payment due date for that statement (UTC midnight). */
  dueDate: Date | null;
}

function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d));
}

/** Clamp a "day of month" to what the target month actually has. */
function dayInMonth(y: number, m: number, day: number): Date {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return utc(y, m, Math.min(day, last));
}

/**
 * The open cycle `now` falls in. Bank convention: the statement generated
 * on the 13th covers the 13th of last month through the 12th of this
 * month, so on the statement day itself a new cycle has already started.
 */
export function currentBillingCycle(
  billingDay: number,
  now: Date,
  dueDay?: number | null,
): BillingCycle {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const today = now.getUTCDate();
  const thisMonthStatement = dayInMonth(y, m, billingDay);
  const statementDate =
    today < thisMonthStatement.getUTCDate() ? thisMonthStatement : dayInMonth(y, m + 1, billingDay);
  const from = dayInMonth(
    statementDate.getUTCFullYear(),
    statementDate.getUTCMonth() - 1,
    billingDay,
  );
  const to = new Date(statementDate.getTime() - 24 * 60 * 60 * 1000);
  return { from, to, statementDate, dueDate: dueDateFor(statementDate, dueDay) };
}

/** First occurrence of `dueDay` strictly after the statement date. */
export function dueDateFor(statementDate: Date, dueDay?: number | null): Date | null {
  if (!dueDay) return null;
  const y = statementDate.getUTCFullYear();
  const m = statementDate.getUTCMonth();
  const sameMonth = dayInMonth(y, m, dueDay);
  return sameMonth.getTime() > statementDate.getTime() ? sameMonth : dayInMonth(y, m + 1, dueDay);
}

// ---------------------------------------------------------------------------
// Outstanding / utilisation
// ---------------------------------------------------------------------------

export interface CardLedgerRow {
  direction: 'IN' | 'OUT';
  amount: number;
  date: Date;
  /** Row is spend/refund ON this card. */
  onCard: boolean;
  /** Row is a repayment that settles this card. */
  settlesCard: boolean;
}

export interface CardPosition {
  spend: number;
  refunds: number;
  repaid: number;
  outstanding: number;
  available: number | null;
  /** 0–1 (or >1 when over limit); null without a limit. */
  utilisation: number | null;
  cycleSpend: number;
  cycleRepaid: number;
}

export function computeCardPosition(
  rows: readonly CardLedgerRow[],
  creditLimit: number | null | undefined,
  cycle?: Pick<BillingCycle, 'from' | 'to'> | null,
): CardPosition {
  let spend = 0;
  let refunds = 0;
  let repaid = 0;
  let cycleSpend = 0;
  let cycleRepaid = 0;
  const inCycle = (d: Date) =>
    !!cycle &&
    d.getTime() >= cycle.from.getTime() &&
    d.getTime() <= cycle.to.getTime() + 24 * 60 * 60 * 1000 - 1;
  for (const r of rows) {
    const amount = Number.isFinite(r.amount) ? r.amount : 0;
    if (r.onCard) {
      if (r.direction === 'OUT') {
        spend += amount;
        if (inCycle(r.date)) cycleSpend += amount;
      } else {
        refunds += amount;
      }
    }
    if (r.settlesCard && r.direction === 'OUT') {
      repaid += amount;
      if (inCycle(r.date)) cycleRepaid += amount;
    }
  }
  const outstanding = round2(spend - refunds - repaid);
  const limit = creditLimit && creditLimit > 0 ? creditLimit : null;
  return {
    spend: round2(spend),
    refunds: round2(refunds),
    repaid: round2(repaid),
    outstanding,
    available: limit === null ? null : round2(limit - outstanding),
    utilisation: limit === null ? null : Math.round((outstanding / limit) * 1000) / 1000,
    cycleSpend: round2(cycleSpend),
    cycleRepaid: round2(cycleRepaid),
  };
}

export type CardHealth = 'OK' | 'HIGH' | 'FULL' | 'OVER' | 'NO_LIMIT';

/** Traffic light for the accounts page. */
export function cardHealth(position: CardPosition): CardHealth {
  if (position.utilisation === null) return 'NO_LIMIT';
  if (position.utilisation > 1) return 'OVER';
  if (position.utilisation >= 0.95) return 'FULL';
  if (position.utilisation >= 0.8) return 'HIGH';
  return 'OK';
}

export const CARD_HEALTH_LABELS: Record<CardHealth, string> = {
  OK: 'OK',
  HIGH: 'Near limit',
  FULL: 'Limit reached',
  OVER: 'Over limit',
  NO_LIMIT: 'No limit set',
};
