import { describe, expect, it } from 'vitest';

import { financeAccountCreateSchema, financeTransactionCreateSchema } from './finance';

const base = {
  date: '2026-10-04',
  direction: 'OUT',
  category: 'ADS',
  amount: 10000,
};

describe('amounts are kept to the paisa', () => {
  it('rounds a finer amount to the paisa', () => {
    expect(financeTransactionCreateSchema.parse({ ...base, amount: 1234.567 }).amount).toBe(1234.57);
    expect(financeTransactionCreateSchema.parse({ ...base, amount: 215.94 }).amount).toBe(215.94);
  });

  it('refuses an amount that rounds to nothing', () => {
    const r = financeTransactionCreateSchema.safeParse({ ...base, amount: 0.004 });
    expect(r.success).toBe(false);
  });

  it('rounds each card share, so a split is compared to the paisa', () => {
    const v = financeTransactionCreateSchema.parse({
      ...base,
      category: 'CARD_REPAYMENT',
      amount: 40000,
      cardSplit: [
        { accountId: 'icici', amount: 18587.004 },
        { accountId: 'rbl', amount: 21412.996 },
      ],
    });
    expect(v.cardSplit!.map((s) => s.amount)).toEqual([18587, 21413]);
  });

  it('rounds a signed opening balance too', () => {
    const v = financeAccountCreateSchema.parse({ name: 'YES BANK', type: 'BANK', openingBalance: 5096.8249 });
    expect(v.openingBalance).toBe(5096.82);
    const card = financeAccountCreateSchema.parse({ name: 'Card', type: 'CREDIT_CARD', openingBalance: -100.004 });
    expect(card.openingBalance).toBe(-100);
  });
});
