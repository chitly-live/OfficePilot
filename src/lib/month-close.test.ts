import { describe, expect, it } from 'vitest';

import {
  closingBalances,
  findDrift,
  isLocked,
  isMonthKey,
  lastEndedMonth,
  monthEnd,
  monthsToClose,
} from './month-close';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('isLocked', () => {
  it('locks the closed month and everything before it', () => {
    expect(isLocked(at('2026-08-31'), '2026-08')).toBe(true);
    expect(isLocked(at('2026-07-15'), '2026-08')).toBe(true);
    expect(isLocked(new Date('2026-08-31T23:59:59.999Z'), '2026-08')).toBe(true);
  });

  it('leaves the next month open', () => {
    expect(isLocked(at('2026-09-01'), '2026-08')).toBe(false);
  });

  it('locks nothing when nothing is closed', () => {
    expect(isLocked(at('2020-01-01'), null)).toBe(false);
  });
});

describe('closingBalances', () => {
  // YES BANK in miniature: opening 5,096.82, one settlement in August,
  // one payout in September.
  const accounts = [
    { id: 'bank', openingBalance: 5096.82 },
    { id: 'card', openingBalance: 0 },
  ];
  const rows = [
    { accountId: 'bank', date: at('2026-08-01'), direction: 'IN' as const, amount: 231.54 },
    { accountId: 'bank', date: new Date('2026-08-31T00:00:00.000Z'), direction: 'OUT' as const, amount: 7 },
    { accountId: 'bank', date: at('2026-09-01'), direction: 'OUT' as const, amount: 1000 },
    { accountId: 'card', date: at('2026-08-10'), direction: 'OUT' as const, amount: 5000 },
    { accountId: null, date: at('2026-08-10'), direction: 'OUT' as const, amount: 18012 },
  ];

  it('counts rows up to the last day of the month, not after', () => {
    const b = closingBalances(accounts, rows, '2026-08');
    expect(b.get('bank')).toBe(5321.36);
    expect(b.get('card')).toBe(-5000);
  });

  it('gives an untouched account its opening balance', () => {
    expect(closingBalances(accounts, [], '2026-08').get('bank')).toBe(5096.82);
  });
});

describe('findDrift', () => {
  it('reports only accounts that moved, to the paisa', () => {
    const recorded = [
      { accountId: 'bank', accountName: 'YES BANK', balance: 22456.05 },
      { accountId: 'card', accountName: 'RBL', balance: -5000 },
    ];
    const now = new Map([
      ['bank', 22456.05],
      ['card', -5349],
    ]);
    expect(findDrift(recorded, now)).toEqual([
      { accountId: 'card', accountName: 'RBL', recorded: -5000, now: -5349, difference: -349 },
    ]);
  });
});

describe('monthsToClose', () => {
  it('starts from the first ledger month when nothing is closed yet', () => {
    expect(monthsToClose('2026-09', null, '2026-08')).toEqual(['2026-08', '2026-09']);
  });

  it('continues after the current lock', () => {
    expect(monthsToClose('2026-10', '2026-08', '2026-08')).toEqual(['2026-09', '2026-10']);
  });

  it('crosses a year end', () => {
    expect(monthsToClose('2027-01', '2026-11', null)).toEqual(['2026-12', '2027-01']);
  });

  it('closes just the month when the ledger starts later', () => {
    expect(monthsToClose('2026-09', null, '2026-10')).toEqual(['2026-09']);
    expect(monthsToClose('2026-09', null, null)).toEqual(['2026-09']);
  });

  it('returns nothing when the month is already locked', () => {
    expect(monthsToClose('2026-08', '2026-09', null)).toEqual([]);
  });
});

describe('helpers', () => {
  it('validates month keys', () => {
    expect(isMonthKey('2026-09')).toBe(true);
    expect(isMonthKey('2026-13')).toBe(false);
    expect(isMonthKey('2026-9')).toBe(false);
  });

  it('knows when a month ends', () => {
    expect(monthEnd('2026-02').toISOString()).toBe('2026-02-28T23:59:59.999Z');
  });

  it('suggests the month that has just ended', () => {
    expect(lastEndedMonth(at('2026-10-01'))).toBe('2026-09');
    expect(lastEndedMonth(at('2026-01-15'))).toBe('2025-12');
  });
});
