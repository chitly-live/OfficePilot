import { describe, expect, it } from 'vitest';

import { allocateLoanRepayments, dueStatus } from './dues';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

describe('allocateLoanRepayments', () => {
  it('clears the oldest loan first, so a repaid loan never shows as due', () => {
    const loans = allocateLoanRepayments(
      [
        { id: 'aug', date: at('2026-08-01'), amount: 50000 },
        { id: 'jan', date: at('2026-01-10'), amount: 100000 },
      ],
      100000,
    );
    expect(loans.map((l) => [l.id, l.remaining])).toEqual([
      ['jan', 0],
      ['aug', 50000],
    ]);
  });

  it('never double counts: the remainders add up to what is still owed', () => {
    const loans = allocateLoanRepayments(
      [
        { date: at('2026-09-01'), amount: 100000 },
        { date: at('2026-09-15'), amount: 50000 },
      ],
      30000,
    );
    expect(loans.reduce((s, l) => s + l.remaining, 0)).toBe(120000);
  });
});

describe('dueStatus', () => {
  const today = at('2026-09-29');
  it('buckets by days to go', () => {
    expect(dueStatus(at('2026-09-28'), false, today)).toBe('OVERDUE');
    expect(dueStatus(at('2026-10-02'), false, today)).toBe('DUE_SOON');
    expect(dueStatus(at('2026-10-20'), false, today)).toBe('UPCOMING');
    expect(dueStatus(at('2026-09-28'), true, today)).toBe('DONE');
  });
});
