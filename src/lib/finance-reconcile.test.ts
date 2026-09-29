import { describe, expect, it } from 'vitest';

import type { StatementLine } from './bank-statement';
import { isNewestFirst, statementDayEnds } from './finance-reconcile';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);
const l = (o: Partial<StatementLine> & Pick<StatementLine, 'date' | 'amount' | 'balance'>): StatementLine => ({
  line: 0,
  direction: 'OUT',
  description: '',
  reference: '',
  ...o,
});

describe('statementDayEnds', () => {
  it('reads a newest-first file whose lines all fall on one day', () => {
    // YES BANK prints the AMB fee after its GST: newest first, same date.
    const lines = [
      l({ date: at('2026-08-04'), amount: 1500, balance: 5005.5, description: 'AMB CHRGS FOR Jul 2026' }),
      l({ date: at('2026-08-04'), amount: 270, balance: 6505.5, description: 'GST' }),
    ];
    expect(isNewestFirst(lines)).toBe(true);
    expect(statementDayEnds(lines).get('2026-08-04')).toBe(5005.5);
  });

  it('reads an oldest-first file', () => {
    const lines = [
      l({ date: at('2026-08-04'), amount: 270, balance: 6505.5 }),
      l({ date: at('2026-08-04'), amount: 1500, balance: 5005.5 }),
      l({ date: at('2026-08-05'), amount: 100, direction: 'IN', balance: 5105.5 }),
    ];
    expect(isNewestFirst(lines)).toBe(false);
    expect(statementDayEnds(lines)).toEqual(new Map([['2026-08-04', 5005.5], ['2026-08-05', 5105.5]]));
  });

  it('matches the real August file order (newest first across days)', () => {
    const lines = [
      l({ date: at('2026-08-31'), amount: 7, balance: 22456.05 }),
      l({ date: at('2026-08-31'), amount: 1.26, balance: 22463.05 }),
      l({ date: at('2026-08-31'), amount: 8046.34, direction: 'IN', balance: 22464.31 }),
      l({ date: at('2026-08-30'), amount: 3.5, balance: 14417.97 }),
    ];
    expect(statementDayEnds(lines).get('2026-08-31')).toBe(22456.05);
  });
});
