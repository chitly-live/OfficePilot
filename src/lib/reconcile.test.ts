import { describe, expect, it } from 'vitest';

import type { StatementLine } from './bank-statement';
import { reconcile, suggestFor, type LedgerLine } from './reconcile';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

let n = 0;
const line = (o: Partial<StatementLine> & Pick<StatementLine, 'date' | 'amount'>): StatementLine => ({
  line: ++n,
  direction: 'OUT',
  description: '',
  reference: '',
  balance: null,
  ...o,
});

const row = (o: Partial<LedgerLine> & Pick<LedgerLine, 'id' | 'date' | 'amount'>): LedgerLine => ({
  direction: 'OUT',
  category: 'OTHER_EXPENSE',
  description: null,
  reference: null,
  partyId: null,
  partyName: null,
  ...o,
});

describe('reconcile', () => {
  it('pairs by reference first, even across a date gap', () => {
    const r = reconcile(
      [line({ date: at('2026-09-01'), amount: 14298.22, direction: 'IN', reference: 'AXISCN1453493499' })],
      [row({ id: 'a', date: at('2026-09-05'), amount: 14298.22, direction: 'IN', reference: 'axiscn1453493499' })],
    );
    expect(r.matched).toHaveLength(1);
    expect(r.matched[0]).toMatchObject({ kind: 'reference', dayShift: 4 });
    expect(r.missing).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('pairs equal amounts with the right day', () => {
    // Two ₹3.50 IMPS charges on different days — each goes to its own day.
    const lines = [line({ date: at('2026-09-16'), amount: 3.5 }), line({ date: at('2026-09-18'), amount: 3.5 })];
    const rows = [row({ id: 'late', date: at('2026-09-18'), amount: 3.5 }), row({ id: 'early', date: at('2026-09-16'), amount: 3.5 })];
    const r = reconcile(lines, rows);
    expect(r.matched.map((m) => [m.line.date.toISOString().slice(0, 10), m.row.id])).toEqual([
      ['2026-09-16', 'early'],
      ['2026-09-18', 'late'],
    ]);
    expect(r.matched.every((m) => m.kind === 'date')).toBe(true);
  });

  it('allows a short value-date lag, not a long one', () => {
    const r = reconcile(
      [line({ date: at('2026-09-10'), amount: 500 }), line({ date: at('2026-09-10'), amount: 700 })],
      [row({ id: 'near', date: at('2026-09-12'), amount: 500 }), row({ id: 'far', date: at('2026-09-20'), amount: 700 })],
    );
    expect(r.matched.map((m) => [m.row.id, m.kind])).toEqual([['near', 'near_date']]);
    expect(r.missing.map((m) => m.line.amount)).toEqual([700]);
    expect(r.extra.map((x) => x.id)).toEqual(['far']);
  });

  it('never matches money going the other way', () => {
    const r = reconcile(
      [line({ date: at('2026-09-10'), amount: 1000, direction: 'IN' })],
      [row({ id: 'x', date: at('2026-09-10'), amount: 1000, direction: 'OUT' })],
    );
    expect(r.matched).toEqual([]);
    expect(r.missing).toHaveLength(1);
    expect(r.extra).toHaveLength(1);
  });

  it('matches to the paisa, not roughly', () => {
    const r = reconcile(
      [line({ date: at('2026-09-10'), amount: 8914.61, direction: 'IN' })],
      [row({ id: 'x', date: at('2026-09-10'), amount: 8914.6, direction: 'IN' })],
    );
    expect(r.matched).toEqual([]);
  });

  it('totals both sides', () => {
    const r = reconcile(
      [line({ date: at('2026-09-10'), amount: 100, direction: 'IN' }), line({ date: at('2026-09-10'), amount: 40 })],
      [row({ id: 'x', date: at('2026-09-10'), amount: 100, direction: 'IN' })],
    );
    expect(r.totals).toEqual({ statementIn: 100, statementOut: 40, ledgerIn: 100, ledgerOut: 0 });
  });
});

describe('suggestFor', () => {
  const charge = line({
    date: at('2026-09-27'),
    amount: 6,
    description: 'IMPS PAYMENT CHRGS for 25-Sep-2026',
    reference: 'ORMB960000000001',
  });
  const gst = line({ date: at('2026-09-27'), amount: 1.08, description: 'GST', reference: 'ORMB960000000001' });

  it('describes an IMPS charge the way the ledger does', () => {
    expect(suggestFor(charge, [charge, gst], [])).toMatchObject({
      category: 'BANK_CHARGES',
      description: 'IMPS charges for 25-Sep-2026',
      basis: 'rule',
    });
  });

  it('ties a bare GST line to the charge with the same reference', () => {
    expect(suggestFor(gst, [charge, gst], [])).toMatchObject({
      category: 'BANK_CHARGES',
      description: 'GST on IMPS charges for 25-Sep-2026',
    });
  });

  it('learns category and party from past rows', () => {
    const history = [
      row({
        id: 'h',
        date: at('2026-09-24'),
        amount: 9609.27,
        direction: 'IN',
        category: 'SALES',
        description: 'Cashfree settlement · sales 22 Sep 2026',
        partyId: 'p-cashfree',
        partyName: 'CASHFREE',
      }),
    ];
    const s = suggestFor(
      line({ date: at('2026-09-29'), amount: 7000, direction: 'IN', description: 'NEFT-AXISCN1-CASHFREE PAYMENTS' }),
      [],
      history,
    );
    expect(s).toMatchObject({ category: 'SALES', partyId: 'p-cashfree', basis: 'history' });
  });

  it('admits when it has no idea', () => {
    expect(suggestFor(line({ date: at('2026-09-29'), amount: 5, description: 'XYZ' }), [], [])).toMatchObject({
      category: null,
      basis: 'none',
    });
  });
});
