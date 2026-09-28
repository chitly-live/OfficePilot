/**
 * Unit tests for `src/lib/credit-card.ts` — billing cycle / due date maths
 * and card outstanding / utilisation.
 */

import { describe, expect, it } from 'vitest';

import {
  cardHealth,
  computeCardPosition,
  currentBillingCycle,
  dueDateFor,
  type CardLedgerRow,
} from './credit-card';

const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('currentBillingCycle', () => {
  it('RBL: statement on the 13th covers 13 Aug – 12 Sep, due on the 1st of next month', () => {
    const c = currentBillingCycle(13, at('2026-09-06'), 1);
    expect(iso(c.from)).toBe('2026-08-13');
    expect(iso(c.to)).toBe('2026-09-12');
    expect(iso(c.statementDate)).toBe('2026-09-13');
    expect(iso(c.dueDate)).toBe('2026-10-01');
  });

  it('on the statement day itself a new cycle has already started', () => {
    const c = currentBillingCycle(13, at('2026-09-13'), 1);
    expect(iso(c.from)).toBe('2026-09-13');
    expect(iso(c.to)).toBe('2026-10-12');
    expect(iso(c.statementDate)).toBe('2026-10-13');
    expect(iso(c.dueDate)).toBe('2026-11-01');
  });

  it('the day before the statement is still the old cycle', () => {
    const c = currentBillingCycle(13, at('2026-09-12'), 1);
    expect(iso(c.from)).toBe('2026-08-13');
    expect(iso(c.statementDate)).toBe('2026-09-13');
  });

  it('SBI: statement on the 10th, due on the 29th of the same month', () => {
    const c = currentBillingCycle(10, at('2026-09-06'), 29);
    expect(iso(c.from)).toBe('2026-08-10');
    expect(iso(c.to)).toBe('2026-09-09');
    expect(iso(c.statementDate)).toBe('2026-09-10');
    expect(iso(c.dueDate)).toBe('2026-09-29');
  });

  it('clamps to short months and wraps the year', () => {
    const c = currentBillingCycle(31, at('2026-02-10'), 15);
    expect(iso(c.statementDate)).toBe('2026-02-28');
    expect(iso(c.from)).toBe('2026-01-31');
    expect(iso(c.to)).toBe('2026-02-27');
    expect(iso(c.dueDate)).toBe('2026-03-15');
    const dec = currentBillingCycle(17, at('2026-12-20'), 5);
    expect(iso(dec.from)).toBe('2026-12-17');
    expect(iso(dec.statementDate)).toBe('2027-01-17');
    expect(iso(dec.dueDate)).toBe('2027-02-05');
  });

  it('dueDateFor returns null without a due day', () => {
    expect(dueDateFor(at('2026-09-13'), null)).toBeNull();
  });
});

describe('computeCardPosition', () => {
  const cycle = { from: at('2026-08-13'), to: at('2026-09-12') };
  const rows: CardLedgerRow[] = [
    { direction: 'OUT', amount: 12000, date: at('2026-08-07'), onCard: true, settlesCard: false }, // previous cycle
    { direction: 'OUT', amount: 29722, date: at('2026-08-12'), onCard: true, settlesCard: false },
    { direction: 'OUT', amount: 30000, date: at('2026-08-20'), onCard: true, settlesCard: false },
    { direction: 'IN', amount: 500, date: at('2026-08-21'), onCard: true, settlesCard: false }, // refund
    { direction: 'OUT', amount: 20000, date: at('2026-08-26'), onCard: false, settlesCard: true }, // repayment
  ];

  it('outstanding = spend − refunds − repayments; available against the limit', () => {
    const p = computeCardPosition(rows, 60000, cycle);
    expect(p).toMatchObject({
      spend: 71722,
      refunds: 500,
      repaid: 20000,
      outstanding: 51222,
      available: 8778,
      cycleSpend: 30000,
      cycleRepaid: 20000,
    });
    expect(p.utilisation).toBeCloseTo(0.854, 3);
    expect(cardHealth(p)).toBe('HIGH');
  });

  it('flags full and over limit, and no-limit cards', () => {
    expect(cardHealth(computeCardPosition(rows, 52000, cycle))).toBe('FULL');
    expect(cardHealth(computeCardPosition(rows, 50000, cycle))).toBe('OVER');
    const none = computeCardPosition(rows, null, null);
    expect(none.available).toBeNull();
    expect(cardHealth(none)).toBe('NO_LIMIT');
    expect(none.cycleSpend).toBe(0);
  });
});

describe('computeCardPosition — one payment split across cards', () => {
  // A single 70,000 bank transfer cleared two cards: 37,222 to this one and
  // 32,778 to another. The ledger keeps ONE row of 70,000 (it must match the
  // bank statement line), so only this card's share may be counted here.
  const split = (share: number) =>
    computeCardPosition(
      [
        { direction: 'OUT', amount: 50000, date: at('2026-09-05'), onCard: true, settlesCard: false },
        {
          direction: 'OUT',
          amount: 70000,
          date: at('2026-09-21'),
          onCard: false,
          settlesCard: false,
          settlesAmount: share,
        },
      ],
      60000,
    );

  it('counts only the share, never the whole payment', () => {
    const pos = split(37222);
    expect(pos.spend).toBe(50000);
    expect(pos.repaid).toBe(37222);
    expect(pos.outstanding).toBe(12778);
    expect(pos.available).toBe(47222);
  });

  it('a zero share leaves the card untouched', () => {
    const pos = split(0);
    expect(pos.repaid).toBe(0);
    expect(pos.outstanding).toBe(50000);
  });

  it('settlesAmount wins over the settlesCard shortcut', () => {
    const pos = computeCardPosition(
      [
        { direction: 'OUT', amount: 50000, date: at('2026-09-05'), onCard: true, settlesCard: false },
        {
          direction: 'OUT',
          amount: 70000,
          date: at('2026-09-21'),
          onCard: false,
          settlesCard: true,
          settlesAmount: 37222,
        },
      ],
      60000,
    );
    expect(pos.repaid).toBe(37222);
  });

  it('an IN row never settles anything', () => {
    const pos = computeCardPosition(
      [
        { direction: 'OUT', amount: 5000, date: at('2026-09-05'), onCard: true, settlesCard: false },
        { direction: 'IN', amount: 1000, date: at('2026-09-06'), onCard: false, settlesCard: true, settlesAmount: 1000 },
      ],
      60000,
    );
    expect(pos.repaid).toBe(0);
    expect(pos.outstanding).toBe(5000);
  });
});
