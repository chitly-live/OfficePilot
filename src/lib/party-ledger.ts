/**
 * Turns a party's transactions into a ledger the way the owner reads it:
 * how much of theirs we used, how much we paid them back, how much they
 * sent us, and what is still owed after each line.
 *
 * Mirrors the classification in `computePartyBalance` so the running
 * balance always lands on the same figure the stat cards show.
 *
 * Pure — no DB, no clock.
 */

import { round2 } from '@/lib/finance';

export interface PartyLedgerSource {
  id: string;
  date: Date | string;
  direction: 'IN' | 'OUT';
  category: string;
  amount: number;
  /** Set when the row was made on an account this party owns (their card). */
  onTheirAccount: boolean;
}

export interface PartyLedgerLine {
  id: string;
  /** Their money we used: spend on their card, a loan or investment taken. */
  used: number;
  /** Money we sent them: settlements, loan repayments, payouts, salary. */
  paid: number;
  /** Money they sent us: client payments, refunds. */
  received: number;
  /** What we still owed them right after this line. */
  balanceAfter: number;
}

/** How one row moves "what we owe this party". */
export function classifyPartyRow(row: PartyLedgerSource): {
  used: number;
  paid: number;
  received: number;
} {
  const amount = Number.isFinite(row.amount) ? row.amount : 0;

  // Spend on their own card: they funded it, so what we owe goes up. An IN
  // row there is a refund landing back on the card, which brings it down.
  if (row.onTheirAccount) {
    return row.direction === 'OUT'
      ? { used: amount, paid: 0, received: 0 }
      : { used: 0, paid: amount, received: 0 };
  }

  if (row.direction === 'IN') {
    // Cash from them. A loan or investment is ours to repay later, so it
    // counts as used; anything else is simply money received.
    const isFunding = row.category === 'LOAN_RECEIVED' || row.category === 'INVESTMENT_RECEIVED';
    return isFunding
      ? { used: amount, paid: 0, received: 0 }
      : { used: 0, paid: 0, received: amount };
  }

  return { used: 0, paid: amount, received: 0 };
}

/**
 * Attach used / paid / received and a running "we owe" to each row.
 *
 * `rows` must be newest-first (the order the page renders). `closingOwed` is
 * the all-time figure from `computePartyBalance`, so the balance column stays
 * correct even when only the latest rows are shown.
 */
export function buildPartyLedger(
  rows: readonly PartyLedgerSource[],
  closingOwed: number,
): Map<string, PartyLedgerLine> {
  const out = new Map<string, PartyLedgerLine>();
  let balance = closingOwed;
  for (const row of rows) {
    const { used, paid, received } = classifyPartyRow(row);
    out.set(row.id, {
      id: row.id,
      used: round2(used),
      paid: round2(paid),
      received: round2(received),
      balanceAfter: round2(balance),
    });
    // Walking backwards in time: undo this row to get the balance before it,
    // which is the balance shown against the next (older) row.
    balance = round2(balance - used + paid);
  }
  return out;
}

export interface PartyLedgerTotals {
  used: number;
  paid: number;
  received: number;
}

export function sumPartyLedger(lines: Iterable<PartyLedgerLine>): PartyLedgerTotals {
  let used = 0;
  let paid = 0;
  let received = 0;
  for (const l of lines) {
    used += l.used;
    paid += l.paid;
    received += l.received;
  }
  return { used: round2(used), paid: round2(paid), received: round2(received) };
}

/**
 * Whether a running "we owe" column means anything for this party.
 *
 * It only does when they have funded something — a card we spent on, a loan,
 * an investment. For someone we simply pay for work (a host, a vendor) no
 * debt ever builds up, so a balance column would invent numbers that were
 * never owed.
 */
export function hasRunningBalance(totals: PartyLedgerTotals): boolean {
  return totals.used > 0;
}
