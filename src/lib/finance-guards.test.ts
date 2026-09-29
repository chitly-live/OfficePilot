import { describe, expect, it } from 'vitest';

import { checkCardSplitShape, isLikelyDuplicate } from './finance-guards';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('isLikelyDuplicate', () => {
  const stored = {
    date: at('2026-09-18'),
    direction: 'OUT' as const,
    amount: 10000,
    accountId: 'axis',
    reference: null,
  };

  it('flags the same amount on the same account within a day', () => {
    const probe = { date: at('2026-09-19'), direction: 'OUT' as const, amount: 10000, accountId: 'axis' };
    expect(isLikelyDuplicate(probe, stored)).toBe('same_amount');
  });

  it('lets the same amount through on a different card', () => {
    const probe = { date: at('2026-09-18'), direction: 'OUT' as const, amount: 10000, accountId: 'rbl' };
    expect(isLikelyDuplicate(probe, stored)).toBeNull();
  });

  it('lets it through two days apart, or in the other direction', () => {
    expect(
      isLikelyDuplicate({ date: at('2026-09-20'), direction: 'OUT', amount: 10000, accountId: 'axis' }, stored),
    ).toBeNull();
    expect(
      isLikelyDuplicate({ date: at('2026-09-18'), direction: 'IN', amount: 10000, accountId: 'axis' }, stored),
    ).toBeNull();
  });

  it('is exact to the paisa', () => {
    expect(
      isLikelyDuplicate({ date: at('2026-09-18'), direction: 'OUT', amount: 10000.01, accountId: 'axis' }, stored),
    ).toBeNull();
  });

  it('treats the same UTR with the same money as a duplicate, on any account or date', () => {
    const withRef = { ...stored, direction: 'IN' as const, amount: 12096.16, accountId: 'yes', reference: 'AXISCN1481398175' };
    const probe = {
      date: at('2026-10-15'),
      direction: 'IN' as const,
      amount: 12096.16,
      accountId: null,
      reference: ' axiscn1481398175 ',
    };
    expect(isLikelyDuplicate(probe, withRef)).toBe('same_reference');
  });

  it('does not flag equal charges on adjacent days that carry different UTRs', () => {
    const aug31 = { date: at('2026-08-31'), direction: 'OUT' as const, amount: 7, accountId: 'yes', reference: 'ORMB957221750355' };
    const sep01 = { date: at('2026-09-01'), direction: 'OUT' as const, amount: 7, accountId: 'yes', reference: 'ORMB957300000001' };
    expect(isLikelyDuplicate(sep01, aug31)).toBeNull();
    // Without references there is nothing to tell them apart: still a warning.
    expect(isLikelyDuplicate({ ...sep01, reference: null }, { ...aug31, reference: null })).toBe('same_amount');
  });

  it('does not flag an IMPS charge and its GST, which share one reference', () => {
    const charge = { date: at('2026-09-27'), direction: 'OUT' as const, amount: 6, accountId: 'yes', reference: 'ORMB960000000001' };
    const gst = { date: at('2026-09-27'), direction: 'OUT' as const, amount: 1.08, accountId: 'yes', reference: 'ORMB960000000001' };
    expect(isLikelyDuplicate(gst, charge)).toBeNull();
  });

  it('rounds each split share before checking the total', () => {
    const payment = { category: 'CARD_REPAYMENT' as const, direction: 'OUT' as const, amount: 1000 };
    // 333.333 ×3 rounds to 999.99 stored — a paisa short.
    expect(() =>
      checkCardSplitShape(payment, [
        { accountId: 'a', amount: 333.333 },
        { accountId: 'b', amount: 333.333 },
        { accountId: 'c', amount: 333.334 },
      ]),
    ).toThrow(/to the paisa/);
  });
});

describe('checkCardSplitShape', () => {
  const payment = { category: 'CARD_REPAYMENT' as const, direction: 'OUT' as const, amount: 70000 };

  it('accepts the real ₹70,000 split: RBL 37,222 + ICICI 32,778', () => {
    expect(() =>
      checkCardSplitShape(payment, [
        { accountId: 'rbl', amount: 37222 },
        { accountId: 'icici', amount: 32778 },
      ]),
    ).not.toThrow();
  });

  it('refuses a split that is a rupee short', () => {
    expect(() =>
      checkCardSplitShape(payment, [
        { accountId: 'rbl', amount: 37222 },
        { accountId: 'icici', amount: 32777 },
      ]),
    ).toThrow(/must match to the paisa/);
  });

  it('refuses the same card twice, a single card, or a zero share', () => {
    expect(() =>
      checkCardSplitShape(payment, [
        { accountId: 'rbl', amount: 35000 },
        { accountId: 'rbl', amount: 35000 },
      ]),
    ).toThrow(/only once/);
    expect(() => checkCardSplitShape(payment, [{ accountId: 'rbl', amount: 70000 }])).toThrow(/at least two/);
    expect(() =>
      checkCardSplitShape(payment, [
        { accountId: 'rbl', amount: 70000 },
        { accountId: 'icici', amount: 0 },
      ]),
    ).toThrow(/above zero/);
  });

  it('only splits card repayments', () => {
    expect(() =>
      checkCardSplitShape({ ...payment, category: 'ADS' }, [
        { accountId: 'rbl', amount: 35000 },
        { accountId: 'icici', amount: 35000 },
      ]),
    ).toThrow(/Only a card repayment/);
  });
});
