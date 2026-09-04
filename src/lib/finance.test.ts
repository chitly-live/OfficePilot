/**
 * Unit tests for `src/lib/finance.ts` — the pure ledger helpers behind
 * the Finance module.
 *
 * No I/O, no Prisma. Covers:
 *   • category metadata invariants (every enum value mapped, directions
 *     consistent, financing categories identified)
 *   • money formatting (Indian grouping, negatives, non-finite input)
 *   • UTC date helpers (parse, month range, month shifting, labels)
 *   • ledger maths: totals, per-category grouping, "kitna dena hai"
 *     party balances (loans + borrowed cards), account balances
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { FinanceCategory } from '@prisma/client';

import {
  ALL_FINANCE_ACCOUNT_TYPES,
  ALL_FINANCE_CATEGORIES,
  ALL_FINANCE_PARTY_TYPES,
  FINANCE_CATEGORY_META,
  categoriesForDirection,
  categoryDirection,
  categoryLabel,
  computeAccountBalance,
  computePartyBalance,
  formatDateUtc,
  formatInr,
  groupByCategory,
  isOperatingCategory,
  monthLabel,
  monthRange,
  parseDateOnly,
  round2,
  shiftMonthKey,
  summarizeRows,
  toDateKey,
  toMonthKey,
  type LedgerRow,
} from './finance';

// ---------------------------------------------------------------------------
// Fixtures — the August notebook, more or less
// ---------------------------------------------------------------------------

const FINANCER = 'party-financer';
const CARD_OWNER = 'party-card-owner';
const HOST = 'party-host';
const OWNED_CARD = 'acct-card';
const BANK = 'acct-bank';

function row(partial: Partial<LedgerRow> & Pick<LedgerRow, 'direction' | 'category' | 'amount'>): LedgerRow {
  return { partyId: null, accountId: null, accountOwnerPartyId: null, ...partial };
}

const AUGUST: LedgerRow[] = [
  // Facebook ads, some on the borrowed card, some from the bank.
  row({ direction: 'OUT', category: 'ADS', amount: 6000, accountId: OWNED_CARD, accountOwnerPartyId: CARD_OWNER }),
  row({ direction: 'OUT', category: 'ADS', amount: 12000, accountId: OWNED_CARD, accountOwnerPartyId: CARD_OWNER }),
  row({ direction: 'OUT', category: 'ADS', amount: 8000, accountId: BANK }),
  // ZeroCloud in USD (recorded in INR).
  row({ direction: 'OUT', category: 'SOFTWARE', amount: 29722, accountId: BANK }),
  // Host payouts.
  row({ direction: 'OUT', category: 'PAYOUT', amount: 701, partyId: HOST, accountId: BANK }),
  row({ direction: 'OUT', category: 'PAYOUT', amount: 2117, partyId: HOST, accountId: BANK }),
  // …one of which was refunded.
  row({ direction: 'IN', category: 'REFUND_RECEIVED', amount: 2117, partyId: HOST, accountId: BANK }),
  // CA fee.
  row({ direction: 'OUT', category: 'PROFESSIONAL_FEES', amount: 5900, accountId: BANK }),
  // Financing: loan in, partial repayment, card settled partially.
  row({ direction: 'IN', category: 'LOAN_RECEIVED', amount: 50000, partyId: FINANCER, accountId: BANK }),
  row({ direction: 'OUT', category: 'LOAN_REPAYMENT', amount: 10000, partyId: FINANCER, accountId: BANK }),
  row({ direction: 'OUT', category: 'CARD_REPAYMENT', amount: 5000, partyId: CARD_OWNER, accountId: BANK }),
  // Revenue.
  row({ direction: 'IN', category: 'SALES', amount: 40000, accountId: BANK }),
];

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

describe('FINANCE_CATEGORY_META', () => {
  it('maps every Prisma enum value exactly once', () => {
    const enumValues = Object.values(FinanceCategory).sort();
    expect([...ALL_FINANCE_CATEGORIES].sort()).toEqual(enumValues);
  });

  it('categoriesForDirection partitions the full list', () => {
    const ins = categoriesForDirection('IN');
    const outs = categoriesForDirection('OUT');
    expect(ins.length + outs.length).toBe(ALL_FINANCE_CATEGORIES.length);
    expect(ins.every((c) => categoryDirection(c) === 'IN')).toBe(true);
    expect(outs.every((c) => categoryDirection(c) === 'OUT')).toBe(true);
    expect(ins.some((c) => outs.includes(c))).toBe(false);
  });

  it('flags exactly the financing categories as non-operating', () => {
    const financing = ALL_FINANCE_CATEGORIES.filter((c) => !isOperatingCategory(c)).sort();
    expect(financing).toEqual(
      ['CARD_REPAYMENT', 'INVESTMENT_RECEIVED', 'LOAN_RECEIVED', 'LOAN_REPAYMENT'].sort(),
    );
  });

  it('every category has a non-empty label and hint', () => {
    for (const c of ALL_FINANCE_CATEGORIES) {
      expect(categoryLabel(c).length).toBeGreaterThan(0);
      expect(FINANCE_CATEGORY_META[c].hint.length).toBeGreaterThan(0);
    }
  });

  it('party / account type lists are complete', () => {
    expect(ALL_FINANCE_PARTY_TYPES).toHaveLength(6);
    expect(ALL_FINANCE_ACCOUNT_TYPES).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

describe('formatInr', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(1234567)).toBe('₹12,34,567');
    expect(formatInr(99722)).toBe('₹99,722');
    expect(formatInr(701)).toBe('₹701');
  });

  it('drops trailing .00 but keeps real decimals', () => {
    expect(formatInr(1000)).toBe('₹1,000');
    expect(formatInr(1000.5)).toBe('₹1,000.5');
    expect(formatInr(0.126)).toBe('₹0.13');
  });

  it('renders negatives with a leading minus', () => {
    expect(formatInr(-2500)).toBe('-₹2,500');
  });

  it('never throws on null / undefined / NaN / Infinity', () => {
    expect(formatInr(null)).toBe('₹0');
    expect(formatInr(undefined)).toBe('₹0');
    expect(formatInr(Number.NaN)).toBe('₹0');
    expect(formatInr(Number.POSITIVE_INFINITY)).toBe('₹0');
  });
});

describe('round2', () => {
  it('rounds to two decimals', () => {
    expect(round2(1.005 * 100)).toBe(100.5);
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(-1.239)).toBe(-1.24);
  });
});

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

describe('date helpers', () => {
  it('toMonthKey / toDateKey use the UTC calendar', () => {
    const d = new Date(Date.UTC(2026, 7, 31, 23, 59, 59));
    expect(toMonthKey(d)).toBe('2026-08');
    expect(toDateKey(d)).toBe('2026-08-31');
  });

  it('parseDateOnly accepts YYYY-MM-DD as UTC midnight', () => {
    const d = parseDateOnly('2026-08-07');
    expect(d?.toISOString()).toBe('2026-08-07T00:00:00.000Z');
    expect(parseDateOnly(' 2026-08-07 ')?.toISOString()).toBe('2026-08-07T00:00:00.000Z');
  });

  it('parseDateOnly rejects malformed and impossible dates', () => {
    expect(parseDateOnly('2026-8-7')).toBeNull();
    expect(parseDateOnly('07/08/2026')).toBeNull();
    expect(parseDateOnly('2026-02-31')).toBeNull();
    expect(parseDateOnly('2026-13-01')).toBeNull();
    expect(parseDateOnly('2026-00-10')).toBeNull();
    expect(parseDateOnly('')).toBeNull();
  });

  it('monthRange spans the first ms to the last ms of the month', () => {
    const r = monthRange('2026-02');
    expect(r?.from.toISOString()).toBe('2026-02-01T00:00:00.000Z');
    expect(r?.to.toISOString()).toBe('2026-02-28T23:59:59.999Z');
    expect(monthRange('2024-02')?.to.toISOString()).toBe('2024-02-29T23:59:59.999Z');
  });

  it('monthRange rejects bad keys', () => {
    expect(monthRange('2026-13')).toBeNull();
    expect(monthRange('2026-00')).toBeNull();
    expect(monthRange('202608')).toBeNull();
    expect(monthRange('2026-8')).toBeNull();
  });

  it('shiftMonthKey wraps across year boundaries', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(shiftMonthKey('2026-08', -13)).toBe('2025-07');
    expect(shiftMonthKey('2026-08', 0)).toBe('2026-08');
  });

  it('shiftMonthKey passes malformed input through unchanged', () => {
    expect(shiftMonthKey('garbage', 1)).toBe('garbage');
  });

  it('shiftMonthKey is invertible (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2099 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: -60, max: 60 }),
        (y, m, delta) => {
          const key = `${y}-${String(m).padStart(2, '0')}`;
          expect(shiftMonthKey(shiftMonthKey(key, delta), -delta)).toBe(key);
        },
      ),
    );
  });

  it('monthLabel / formatDateUtc render in UTC regardless of host TZ', () => {
    expect(monthLabel('2026-08')).toBe('August 2026');
    expect(monthLabel('nope')).toBe('nope');
    expect(formatDateUtc(new Date('2026-08-07T00:00:00.000Z'))).toBe('07 Aug 2026');
    expect(formatDateUtc('2026-08-07T23:59:59.999Z')).toBe('07 Aug 2026');
    expect(formatDateUtc(null)).toBe('—');
    expect(formatDateUtc('not a date')).toBe('—');
  });
});

// ---------------------------------------------------------------------------
// Ledger maths
// ---------------------------------------------------------------------------

describe('summarizeRows', () => {
  it('returns zeros for an empty ledger', () => {
    expect(summarizeRows([])).toEqual({
      cashIn: 0,
      cashOut: 0,
      income: 0,
      expense: 0,
      net: 0,
    });
  });

  it('separates cash movement from P&L (financing rows excluded from income/expense)', () => {
    const t = summarizeRows(AUGUST);
    // Cash: everything.
    expect(t.cashIn).toBe(2117 + 50000 + 40000);
    expect(t.cashOut).toBe(6000 + 12000 + 8000 + 29722 + 701 + 2117 + 5900 + 10000 + 5000);
    // P&L: operating only.
    expect(t.income).toBe(2117 + 40000);
    expect(t.expense).toBe(6000 + 12000 + 8000 + 29722 + 701 + 2117 + 5900);
    expect(t.net).toBe(t.income - t.expense);
  });

  it('ignores non-finite amounts instead of poisoning totals', () => {
    const t = summarizeRows([
      row({ direction: 'IN', category: 'SALES', amount: Number.NaN }),
      row({ direction: 'IN', category: 'SALES', amount: 10 }),
    ]);
    expect(t.cashIn).toBe(10);
    expect(t.income).toBe(10);
  });

  it('cashIn − cashOut ≥ … property: income ≤ cashIn and expense ≤ cashOut', () => {
    const arbRow = fc.record({
      direction: fc.constantFrom('IN' as const, 'OUT' as const),
      category: fc.constantFrom(...ALL_FINANCE_CATEGORIES),
      amount: fc.double({ min: 0, max: 1e6, noNaN: true }),
    });
    fc.assert(
      fc.property(fc.array(arbRow, { maxLength: 50 }), (rows) => {
        const t = summarizeRows(rows);
        expect(t.income).toBeLessThanOrEqual(t.cashIn + 0.01);
        expect(t.expense).toBeLessThanOrEqual(t.cashOut + 0.01);
        expect(t.net).toBeCloseTo(t.income - t.expense, 2);
      }),
    );
  });
});

describe('groupByCategory', () => {
  it('sums per category, largest first, with counts', () => {
    const groups = groupByCategory(AUGUST, 'OUT');
    expect(groups[0]).toMatchObject({
      category: 'SOFTWARE',
      amount: 29722,
      count: 1,
      direction: 'OUT',
      kind: 'OPERATING',
    });
    const ads = groups.find((g) => g.category === 'ADS');
    expect(ads).toMatchObject({ amount: 26000, count: 3, label: 'Ads' });
    expect(groups.every((g) => g.direction === 'OUT')).toBe(true);
  });

  it('includes both directions when none is given', () => {
    const groups = groupByCategory(AUGUST);
    expect(groups.some((g) => g.direction === 'IN')).toBe(true);
    expect(groups.some((g) => g.direction === 'OUT')).toBe(true);
    expect(groups.reduce((s, g) => s + g.count, 0)).toBe(AUGUST.length);
  });

  it('returns an empty list for no rows', () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe('computePartyBalance', () => {
  it('financer: owed = loans given − loans repaid', () => {
    const b = computePartyBalance(AUGUST, FINANCER);
    expect(b.loanReceived).toBe(50000);
    expect(b.loanRepaid).toBe(10000);
    expect(b.loanOutstanding).toBe(40000);
    expect(b.cardSpend).toBe(0);
    expect(b.cardOutstanding).toBe(0);
    expect(b.owed).toBe(40000);
    expect(b.receivedFrom).toBe(50000);
    expect(b.paidTo).toBe(10000);
  });

  it('card owner: owed = spend on their card − card repayments', () => {
    const b = computePartyBalance(AUGUST, CARD_OWNER);
    expect(b.cardSpend).toBe(18000);
    expect(b.cardRepaid).toBe(5000);
    expect(b.cardOutstanding).toBe(13000);
    expect(b.loanOutstanding).toBe(0);
    expect(b.owed).toBe(13000);
    // The repayment is the only row linked directly to them.
    expect(b.paidTo).toBe(5000);
    expect(b.receivedFrom).toBe(0);
  });

  it('host / worker: payouts and refunds are tracked but nothing is "owed"', () => {
    const b = computePartyBalance(AUGUST, HOST);
    expect(b.paidTo).toBe(701 + 2117);
    expect(b.receivedFrom).toBe(2117);
    expect(b.owed).toBe(0);
  });

  it('money coming IN through a borrowed card reduces the card spend', () => {
    const rows = [
      row({ direction: 'OUT', category: 'ADS', amount: 1000, accountOwnerPartyId: CARD_OWNER }),
      row({ direction: 'IN', category: 'REFUND_RECEIVED', amount: 300, accountOwnerPartyId: CARD_OWNER }),
    ];
    const b = computePartyBalance(rows, CARD_OWNER);
    expect(b.cardSpend).toBe(700);
    expect(b.owed).toBe(700);
  });

  it('overpaying a loan goes negative (they owe us)', () => {
    const rows = [
      row({ direction: 'IN', category: 'LOAN_RECEIVED', amount: 1000, partyId: FINANCER }),
      row({ direction: 'OUT', category: 'LOAN_REPAYMENT', amount: 1500, partyId: FINANCER }),
    ];
    expect(computePartyBalance(rows, FINANCER).owed).toBe(-500);
  });

  it('unknown party → all zeros', () => {
    const b = computePartyBalance(AUGUST, 'nobody');
    expect(Object.values(b).every((v) => v === 0)).toBe(true);
  });

  it('owed always equals loanOutstanding + cardOutstanding (property)', () => {
    const ids = [FINANCER, CARD_OWNER, HOST, null];
    const arbRow = fc.record({
      direction: fc.constantFrom('IN' as const, 'OUT' as const),
      category: fc.constantFrom(...ALL_FINANCE_CATEGORIES),
      amount: fc.double({ min: 0, max: 1e5, noNaN: true }),
      partyId: fc.constantFrom(...ids),
      accountId: fc.constant(null),
      accountOwnerPartyId: fc.constantFrom(...ids),
    });
    fc.assert(
      fc.property(fc.array(arbRow, { maxLength: 40 }), (rows) => {
        for (const id of [FINANCER, CARD_OWNER, HOST]) {
          const b = computePartyBalance(rows, id);
          expect(b.owed).toBeCloseTo(b.loanOutstanding + b.cardOutstanding, 2);
          expect(b.loanOutstanding).toBeCloseTo(b.loanReceived - b.loanRepaid, 2);
          expect(b.cardOutstanding).toBeCloseTo(b.cardSpend - b.cardRepaid, 2);
        }
      }),
    );
  });
});

describe('computeAccountBalance', () => {
  it('opening + in − out', () => {
    expect(
      computeAccountBalance(1000, [
        { direction: 'IN', amount: 500 },
        { direction: 'OUT', amount: 200 },
        { direction: 'OUT', amount: 50.25 },
      ]),
    ).toBe(1249.75);
  });

  it('borrowed card with no opening balance goes negative as we spend', () => {
    expect(
      computeAccountBalance(0, [
        { direction: 'OUT', amount: 6000 },
        { direction: 'OUT', amount: 12000 },
      ]),
    ).toBe(-18000);
  });

  it('treats a non-finite opening balance as zero', () => {
    expect(computeAccountBalance(Number.NaN, [{ direction: 'IN', amount: 5 }])).toBe(5);
  });
});
