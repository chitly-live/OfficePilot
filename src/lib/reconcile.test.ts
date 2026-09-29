import { describe, expect, it } from 'vitest';

import type { StatementLine } from './bank-statement';
import { counterpartyOf, matchParty, reconcile, suggestFor, type LedgerLine } from './reconcile';

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

  const parties = [
    { id: 'p-cashfree', name: 'CASHFREE' },
    { id: 'p-tinkal', name: 'TINKAL ANANDRAO WANKAR' },
    { id: 'p-rahul', name: 'GADESHIYA RAHULBHAI GHANSHYAMBHAI' },
    { id: 'p-ritu', name: 'RITU KUMARI' },
    { id: 'p-shubham', name: 'SHUBHAM KUMAR' },
  ];

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

  it('reads the AMB charge line', () => {
    const amb = line({ date: at('2026-09-05'), amount: 750, description: 'AMB CHRGS FOR Aug 2026 000261900007090' });
    expect(suggestFor(amb, [amb], [])).toMatchObject({
      category: 'BANK_CHARGES',
      description: 'Average monthly balance (AMB) charges, Aug 2026',
    });
  });

  it('does not call a vendor payment a bank charge because of a word in it', () => {
    for (const description of [
      'IMPS/NA/XXXX1234/RRN:1/PC1/HDFC BANK/AMBIKA STEEL TRADERS/MATERIAL',
      'IMPS/NA/XXXX1234/RRN:1/PC1/HDFC BANK/Jio Store/MOBILE RECHARGE',
      'IMPS/NA/XXXX1234/RRN:1/PC1/HDFC BANK/Courier Co/DELIVERY CHARGES',
    ]) {
      const s = suggestFor(line({ date: at('2026-09-10'), amount: 25000, description }), [], [], parties);
      expect(s.category).not.toBe('BANK_CHARGES');
    }
  });

  it('never suggests an OUT category for a credit', () => {
    const reversal = line({ date: at('2026-09-10'), amount: 1.08, direction: 'IN', description: 'GST' });
    expect(suggestFor(reversal, [reversal], [])).toMatchObject({ category: null, basis: 'none' });
  });

  it('learns category and party from the payee the bank names', () => {
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
      line({
        date: at('2026-09-29'),
        amount: 7000,
        direction: 'IN',
        description: 'NEFT Cr-UTIB0001920-CASHFREE PAYMENTS INDIA P-PRAXXEL TECHNOLOGIES PRIV-AXISCN1481398175',
      }),
      [],
      history,
      parties,
    );
    // The old description carried a date; only its dateless head is reused.
    expect(s).toMatchObject({
      category: 'SALES',
      partyId: 'p-cashfree',
      description: 'Cashfree settlement',
      basis: 'history',
    });
  });

  it('matches on the payee segment only — the masked account and bank name mean nothing', () => {
    const history = [
      row({
        id: 'h',
        date: at('2026-09-20'),
        amount: 2591,
        category: 'PAYOUT',
        description: 'Host payment',
        partyId: 'p-tinkal',
        partyName: 'TINKAL ANANDRAO WANKAR',
      }),
    ];
    const tinkal = line({
      date: at('2026-09-29'),
      amount: 3000,
      description: 'IMPS/NA/XXXX8575/RRN:627/PC45/BANK OF MAHARAS/Tinkal Wankar/HOST PAYMENT',
    });
    expect(suggestFor(tinkal, [], history, parties)).toMatchObject({ partyId: 'p-tinkal', category: 'PAYOUT' });

    // Same bank, same masked-account shape, a payee we have never paid.
    const stranger = line({
      date: at('2026-09-29'),
      amount: 3000,
      description: 'IMPS/NA/XXXX8575/RRN:628/PC46/BANK OF MAHARAS/Ramesh Patil/HOST PAYMENT',
    });
    expect(suggestFor(stranger, [], history, parties)).toMatchObject({ partyId: null, category: null, basis: 'none' });
  });

  it('follows a routed payment to the real party (bank → Ritu → Shubham)', () => {
    const history = [
      row({
        id: 'h',
        date: at('2026-08-26'),
        amount: 20000,
        category: 'CARD_REPAYMENT',
        description: 'Card bill — routed: bank → Ritu Kumari → Shubham',
        partyId: 'p-shubham',
        partyName: 'SHUBHAM KUMAR',
        viaPartyId: 'p-ritu',
      }),
    ];
    const s = suggestFor(
      line({
        date: at('2026-09-29'),
        amount: 15000,
        description: 'IMPS/NA/XXXX0197/RRN:1/PC1/STATE BANK OF I/Ritu Kumari/CARD BILL',
      }),
      [],
      history,
      parties,
    );
    expect(s).toMatchObject({ category: 'CARD_REPAYMENT', partyId: 'p-shubham', viaPartyId: 'p-ritu' });
  });

  it('names the payee but leaves the category open when there is no history', () => {
    const s = suggestFor(
      line({
        date: at('2026-09-29'),
        amount: 500,
        description: 'IMPS/NA/XXXX9923/RRN:1/PC1/STATE BANK OF I/Gadeshiya Rahulbhai Ghanshyambhai/HOST PAYMENT',
      }),
      [],
      [],
      parties,
    );
    expect(s).toMatchObject({ category: null, partyId: 'p-rahul', description: 'Host payment', basis: 'party' });
  });

  it('refuses to guess between two equally good parties', () => {
    const s = suggestFor(
      line({ date: at('2026-09-29'), amount: 500, description: 'IMPS/NA/X/RRN:1/PC1/HDFC/KUMAR/PAY' }),
      [],
      [],
      [...parties, { id: 'p-raj', name: 'RAJ KUMAR' }],
    );
    expect(s.basis).toBe('none');
  });

  it('does not match on a shared surname alone', () => {
    const s = suggestFor(
      line({ date: at('2026-09-29'), amount: 500, description: 'IMPS/NA/X/RRN:1/PC1/HDFC/Amit Kumar/PAY' }),
      [],
      [],
      parties,
    );
    expect(s).toMatchObject({ partyId: null, basis: 'none' });
  });

  it('admits when it has no idea', () => {
    expect(suggestFor(line({ date: at('2026-09-29'), amount: 5, description: 'XYZ' }), [], [])).toMatchObject({
      category: null,
      basis: 'none',
    });
  });
});

describe('counterpartyOf', () => {
  it('reads the payee from each narration shape YES BANK prints', () => {
    expect(counterpartyOf('IMPS/NA/XXXX8575/RRN:1/PC1/BANK OF MAHARAS/Tinkal Wankar/HOST PAYMENT')).toEqual({
      name: 'Tinkal Wankar',
      remark: 'HOST PAYMENT',
    });
    expect(counterpartyOf('NEFT Cr-HDFC0000240-CASHFREE PAYMENTS PVT LTD-PRAXXEL TECHNOLOGIES PRIV-HDFCH01200685966')).toMatchObject({
      name: 'CASHFREE PAYMENTS PVT LTD',
    });
    expect(counterpartyOf('YIB-NEFT-YESME62291-SHUBHAM KUMAR-HDFC0001-META ADS-HDFC BANK')).toEqual({
      name: 'SHUBHAM KUMAR',
      remark: 'META ADS',
    });
    expect(counterpartyOf('REV OF IMPS TXN:160826:622886724142')).toBeNull();
  });
});

describe('matchParty', () => {
  it('ignores filler words like PAYMENTS, PVT, LTD, BANK', () => {
    expect(matchParty('SOME PAYMENTS PVT LTD', [{ id: 'x', name: 'OTHER PAYMENTS PVT LTD' }])).toBeNull();
  });
});

describe('reconcile — hostile statements', () => {
  it('suggests for 5,000 bare GST lines without scanning every other line', () => {
    const lines = Array.from({ length: 5000 }, (_, i) =>
      line({ date: at('2026-08-01'), amount: 1, description: 'GST', reference: `R${'x'.repeat(300)}${i}` }),
    );
    const started = Date.now();
    const r = reconcile(lines, []);
    expect(r.missing).toHaveLength(5000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
