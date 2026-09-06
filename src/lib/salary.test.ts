/**
 * Unit tests for `src/lib/salary.ts`.
 */

import { describe, expect, it } from 'vitest';

import { salaryPaidByMonth, salaryStatus, salaryTimeline } from './salary';

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('salaryPaidByMonth', () => {
  it('sums by the payment month (UTC)', () => {
    const m = salaryPaidByMonth([
      { date: d('2026-08-02'), amount: 2500 },
      { date: d('2026-08-30'), amount: 2500 },
      { date: d('2026-09-02'), amount: 5000 },
    ]);
    expect(m.get('2026-08')).toBe(5000);
    expect(m.get('2026-09')).toBe(5000);
    expect(m.get('2026-07')).toBeUndefined();
  });

  it('ignores non-finite amounts', () => {
    const m = salaryPaidByMonth([{ date: d('2026-08-02'), amount: Number.NaN }]);
    expect(m.get('2026-08')).toBe(0);
  });
});

describe('salaryStatus', () => {
  it('classifies paid / partial / pending / not set', () => {
    expect(salaryStatus(5000, 5000)).toBe('PAID');
    expect(salaryStatus(5000, 4999.5)).toBe('PAID'); // ₹1 tolerance
    expect(salaryStatus(5000, 2500)).toBe('PARTIAL');
    expect(salaryStatus(5000, 0)).toBe('PENDING');
    expect(salaryStatus(null, 2500)).toBe('NOT_SET');
    expect(salaryStatus(0, 0)).toBe('NOT_SET');
  });
});

describe('salaryTimeline', () => {
  it('lists months newest first and skips months before joining', () => {
    const paid = new Map([['2026-08', 5000]]);
    const lines = salaryTimeline({
      expected: 5000,
      paidByMonth: paid,
      from: '2026-05',
      to: '2026-09',
      joinedMonth: '2026-07',
    });
    expect(lines.map((l) => l.month)).toEqual(['2026-09', '2026-08', '2026-07']);
    expect(lines[0]).toMatchObject({ status: 'PENDING', paid: 0 });
    expect(lines[1]).toMatchObject({ status: 'PAID', paid: 5000 });
  });

  it('wraps across the year boundary', () => {
    const lines = salaryTimeline({ expected: 1, paidByMonth: new Map(), from: '2025-11', to: '2026-01' });
    expect(lines.map((l) => l.month)).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('returns nothing for malformed keys', () => {
    expect(salaryTimeline({ expected: 1, paidByMonth: new Map(), from: 'x', to: '2026-01' })).toEqual([]);
  });
});
