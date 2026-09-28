import { describe, expect, it } from 'vitest';

import {
  buildPartyLedger,
  classifyPartyRow,
  hasRunningBalance,
  sumPartyLedger,
  type PartyLedgerSource,
} from './party-ledger';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

const row = (o: Partial<PartyLedgerSource> & { id: string }): PartyLedgerSource => ({
  date: at('2026-09-01'),
  direction: 'OUT',
  category: 'ADS',
  amount: 0,
  onTheirAccount: false,
  ...o,
});

describe('classifyPartyRow', () => {
  it('spend on their card is money of theirs we used', () => {
    expect(
      classifyPartyRow(row({ id: 'a', amount: 10000, onTheirAccount: true, direction: 'OUT' })),
    ).toEqual({ used: 10000, paid: 0, received: 0 });
  });

  it('a refund back onto their card reduces what we owe', () => {
    expect(
      classifyPartyRow(row({ id: 'b', amount: 500, onTheirAccount: true, direction: 'IN' })),
    ).toEqual({ used: 0, paid: 500, received: 0 });
  });

  it('a settlement, payout or salary is money we paid them', () => {
    for (const category of ['CARD_REPAYMENT', 'PAYOUT', 'SALARY', 'LOAN_REPAYMENT']) {
      expect(classifyPartyRow(row({ id: category, amount: 7000, category }))).toEqual({
        used: 0,
        paid: 7000,
        received: 0,
      });
    }
  });

  it('a loan or investment from them is ours to repay, so it counts as used', () => {
    expect(
      classifyPartyRow(row({ id: 'c', amount: 50000, direction: 'IN', category: 'LOAN_RECEIVED' })),
    ).toEqual({ used: 50000, paid: 0, received: 0 });
    expect(
      classifyPartyRow(
        row({ id: 'd', amount: 20000, direction: 'IN', category: 'INVESTMENT_RECEIVED' }),
      ),
    ).toEqual({ used: 20000, paid: 0, received: 0 });
  });

  it('a client payment is simply money received', () => {
    expect(
      classifyPartyRow(row({ id: 'e', amount: 14298.22, direction: 'IN', category: 'SALES' })),
    ).toEqual({ used: 0, paid: 0, received: 14298.22 });
  });
});

describe('buildPartyLedger', () => {
  // Shubham in miniature: two card spends, then one settlement.
  // Owed at the end = 10,000 + 5,000 − 12,000 = 3,000.
  const newestFirst: PartyLedgerSource[] = [
    row({ id: 'settle', date: at('2026-09-21'), amount: 12000, category: 'CARD_REPAYMENT' }),
    row({ id: 'spend2', date: at('2026-09-10'), amount: 5000, onTheirAccount: true }),
    row({ id: 'spend1', date: at('2026-09-05'), amount: 10000, onTheirAccount: true }),
  ];

  it('walks the balance backwards so it lands on the closing figure', () => {
    const lines = buildPartyLedger(newestFirst, 3000);
    expect(lines.get('settle')).toMatchObject({ used: 0, paid: 12000, balanceAfter: 3000 });
    expect(lines.get('spend2')).toMatchObject({ used: 5000, paid: 0, balanceAfter: 15000 });
    expect(lines.get('spend1')).toMatchObject({ used: 10000, paid: 0, balanceAfter: 10000 });
  });

  it('stays correct when only the latest rows are shown', () => {
    // Same party, but the page only rendered the newest two rows. The closing
    // figure still comes from every row, so the balances must not shift.
    const truncated = newestFirst.slice(0, 2);
    const lines = buildPartyLedger(truncated, 3000);
    expect(lines.get('settle')!.balanceAfter).toBe(3000);
    expect(lines.get('spend2')!.balanceAfter).toBe(15000);
  });

  it('totals each column', () => {
    const lines = buildPartyLedger(newestFirst, 3000);
    expect(sumPartyLedger(lines.values())).toEqual({ used: 15000, paid: 12000, received: 0 });
  });

  it('a party we only pay has no running balance to show', () => {
    const payouts: PartyLedgerSource[] = [
      row({ id: 'p2', date: at('2026-09-20'), amount: 2591, category: 'PAYOUT' }),
      row({ id: 'p1', date: at('2026-09-14'), amount: 5661, category: 'PAYOUT' }),
    ];
    const lines = buildPartyLedger(payouts, 0);
    const totals = sumPartyLedger(lines.values());
    expect(totals).toEqual({ used: 0, paid: 8252, received: 0 });
    // Nothing of theirs was ever used, so no debt ever built up and the
    // balance column is hidden rather than showing invented figures.
    expect(hasRunningBalance(totals)).toBe(false);
  });

  it('a card owner does get a running balance', () => {
    const lines = buildPartyLedger(newestFirst, 3000);
    expect(hasRunningBalance(sumPartyLedger(lines.values()))).toBe(true);
  });

  it('a client we only receive from has no balance either', () => {
    const lines = buildPartyLedger(
      [row({ id: 's', direction: 'IN', category: 'SALES', amount: 9000 })],
      0,
    );
    const totals = sumPartyLedger(lines.values());
    expect(totals).toEqual({ used: 0, paid: 0, received: 9000 });
    expect(hasRunningBalance(totals)).toBe(false);
  });
});
