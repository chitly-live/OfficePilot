import { describe, expect, it } from 'vitest';

import { computeAmb, dailyClosingBalances, daysInMonth, type AmbRow } from './amb';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('daysInMonth', () => {
  it('handles 30, 31 and February', () => {
    expect(daysInMonth('2026-09')).toBe(30);
    expect(daysInMonth('2026-08')).toBe(31);
    expect(daysInMonth('2026-02')).toBe(28);
    expect(daysInMonth('2028-02')).toBe(29);
  });
});

describe('dailyClosingBalances', () => {
  it('carries the balance through days with no transactions', () => {
    const rows: AmbRow[] = [
      { date: d('2026-09-02'), direction: 'IN', amount: 1000 },
      { date: d('2026-09-04'), direction: 'OUT', amount: 300 },
    ];
    expect(dailyClosingBalances(500, rows, '2026-09', 5)).toEqual([
      { date: '2026-09-01', balance: 500 },
      { date: '2026-09-02', balance: 1500 },
      { date: '2026-09-03', balance: 1500 },
      { date: '2026-09-04', balance: 1200 },
      { date: '2026-09-05', balance: 1200 },
    ]);
  });

  it('folds everything before the month into day 1 and ignores later months', () => {
    const rows: AmbRow[] = [
      { date: d('2026-08-31'), direction: 'IN', amount: 2000 },
      { date: d('2026-09-01'), direction: 'OUT', amount: 500 },
      { date: d('2026-10-01'), direction: 'IN', amount: 9999 },
    ];
    expect(dailyClosingBalances(0, rows, '2026-09', 2)).toEqual([
      { date: '2026-09-01', balance: 1500 },
      { date: '2026-09-02', balance: 1500 },
    ]);
  });

  it('clamps the day range', () => {
    expect(dailyClosingBalances(100, [], '2026-09', 0)).toEqual([]);
    expect(dailyClosingBalances(100, [], '2026-09', 99)).toHaveLength(30);
  });
});

describe('computeAmb', () => {
  const flat = (balance: number) =>
    computeAmb({ openingBalance: balance, rows: [], month: '2026-09', required: 25000, throughDay: 10 });

  it('averages the days closed so far and projects the month end', () => {
    const r = flat(30000);
    expect(r.daysInMonth).toBe(30);
    expect(r.daysCounted).toBe(10);
    expect(r.daysRemaining).toBe(20);
    expect(r.averageSoFar).toBe(30000);
    expect(r.projectedAverage).toBe(30000);
    expect(r.closingBalance).toBe(30000);
    expect(r.status).toBe('ON_TRACK');
    expect(r.projectedShortfall).toBe(0);
    // 10 days x 30,000 = 300,000 banked; the remaining 20 days only need
    // (750,000 - 300,000) / 20 = 22,500 each to still average 25,000.
    expect(r.neededDailyBalance).toBe(22500);
  });

  it('works out the balance needed for the rest of the month', () => {
    // 10 days at 10,000 = 100,000. Target 25,000 x 30 = 750,000.
    // Remaining 20 days must average (750,000 - 100,000) / 20 = 32,500.
    const r = flat(10000);
    expect(r.averageSoFar).toBe(10000);
    expect(r.neededDailyBalance).toBe(32500);
    expect(r.projectedAverage).toBe(10000);
    expect(r.projectedShortfall).toBe(15000);
    expect(r.status).toBe('AT_RISK');
  });

  it('marks a finished month met or missed', () => {
    const met = computeAmb({
      openingBalance: 26000,
      rows: [],
      month: '2026-08',
      required: 25000,
      throughDay: 31,
    });
    expect(met.daysRemaining).toBe(0);
    expect(met.neededDailyBalance).toBeNull();
    expect(met.status).toBe('DONE_OK');

    const missed = computeAmb({
      openingBalance: 16802,
      rows: [],
      month: '2026-08',
      required: 25000,
      throughDay: 31,
    });
    expect(missed.status).toBe('DONE_SHORT');
    expect(missed.projectedShortfall).toBe(8198);
  });

  it('reports NOT_SET when the account has no AMB requirement', () => {
    const r = computeAmb({ openingBalance: 5, rows: [], month: '2026-09', required: null, throughDay: 5 });
    expect(r.status).toBe('NOT_SET');
    expect(r.required).toBe(0);
    expect(r.neededDailyBalance).toBeNull();
    expect(r.projectedShortfall).toBe(0);
  });

  it('matches the real September figures for the YES BANK account', () => {
    // Opening 22,456.05 on 1 Sep; the two movements that shaped the month.
    const rows: AmbRow[] = [
      { date: d('2026-09-01'), direction: 'OUT', amount: 2248 },
      { date: d('2026-09-02'), direction: 'IN', amount: 5904.55 },
    ];
    const r = computeAmb({
      openingBalance: 22456.05,
      rows,
      month: '2026-09',
      required: 25000,
      throughDay: 3,
    });
    expect(r.days.map((x) => x.balance)).toEqual([20208.05, 26112.6, 26112.6]);
    expect(r.averageSoFar).toBe(24144.42);
    expect(r.status).toBe('ON_TRACK');
  });
});
