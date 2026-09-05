/**
 * Unit tests for `src/lib/finance-report.ts` — window resolution and the pure
 * report assembly (opening / closing per account, category splits, party
 * totals, outstanding balances, transaction mapping).
 */

import { describe, expect, it } from 'vitest';

import {
  assembleFinanceReport,
  companyFromSettings,
  reportFileStem,
  resolveReportWindow,
  type ReportSourceAccount,
  type ReportSourceParty,
  type ReportSourceRow,
} from './finance-report';

const NOW = new Date('2026-09-06T10:00:00.000Z');

const SHUBHAM = 'p-shubham';
const TINKAL = 'p-tinkal';
const CASHFREE = 'p-cashfree';
const YES = 'a-yes';
const CARD = 'a-card';

const parties: ReportSourceParty[] = [
  { id: SHUBHAM, name: 'Shubham', type: 'CARD_OWNER' },
  { id: TINKAL, name: 'Tinkal', type: 'WORKER' },
  { id: CASHFREE, name: 'Cashfree', type: 'CLIENT' },
];

const accounts: ReportSourceAccount[] = [
  { id: YES, name: 'YES BANK', type: 'BANK', openingBalance: 5000, ownerPartyId: null, ownerName: null, isActive: true },
  { id: CARD, name: 'Shubham card', type: 'CREDIT_CARD', openingBalance: 0, ownerPartyId: SHUBHAM, ownerName: 'Shubham', isActive: true },
];

let seq = 0;
function row(
  date: string,
  direction: 'IN' | 'OUT',
  category: ReportSourceRow['category'],
  amount: number,
  extra: Partial<ReportSourceRow> = {},
): ReportSourceRow {
  seq += 1;
  return {
    id: `t${seq}`,
    date: new Date(`${date}T00:00:00.000Z`),
    direction,
    category,
    amount,
    originalAmount: null,
    originalCurrency: null,
    description: null,
    reference: null,
    partyId: null,
    accountId: null,
    accountOwnerPartyId: null,
    partyName: null,
    accountName: null,
    ...extra,
  };
}

const rows: ReportSourceRow[] = [
  // July (before the window) — affects opening balances and outstanding only.
  row('2026-07-20', 'IN', 'SALES', 1000, { partyId: CASHFREE, accountId: YES, partyName: 'Cashfree', accountName: 'YES BANK' }),
  row('2026-07-25', 'OUT', 'ADS', 4000, { accountId: CARD, accountOwnerPartyId: SHUBHAM, accountName: 'Shubham card' }),
  // August (the window)
  row('2026-08-01', 'IN', 'SALES', 20000, { partyId: CASHFREE, accountId: YES, partyName: 'Cashfree', accountName: 'YES BANK', reference: 'UTR1' }),
  row('2026-08-05', 'OUT', 'ADS', 6000, { accountId: CARD, accountOwnerPartyId: SHUBHAM, accountName: 'Shubham card' }),
  row('2026-08-10', 'OUT', 'PAYOUT', 3000, { partyId: TINKAL, accountId: YES, partyName: 'Tinkal', accountName: 'YES BANK' }),
  row('2026-08-12', 'OUT', 'SOFTWARE', 2977, { accountId: CARD, accountOwnerPartyId: SHUBHAM, accountName: 'Shubham card', originalAmount: 30, originalCurrency: 'USD', description: 'ZEGOCLOUD' }),
  row('2026-08-20', 'OUT', 'CARD_REPAYMENT', 5000, { partyId: SHUBHAM, accountId: YES, partyName: 'Shubham', accountName: 'YES BANK' }),
  row('2026-08-25', 'OUT', 'BANK_CHARGES', 23, { accountId: YES, accountName: 'YES BANK' }),
  row('2026-08-31', 'IN', 'LOAN_RECEIVED', 10000, { partyId: SHUBHAM, accountId: YES, partyName: 'Shubham', accountName: 'YES BANK' }),
  // September (after the window) — must be excluded entirely.
  row('2026-09-02', 'OUT', 'ADS', 9999, { accountId: CARD, accountOwnerPartyId: SHUBHAM }),
];

const august = resolveReportWindow({ month: '2026-08' }, NOW)!;

describe('resolveReportWindow', () => {
  it('month → inclusive UTC month range with label and file tag', () => {
    expect(august.kind).toBe('month');
    expect(august.from.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(august.to.toISOString()).toBe('2026-08-31T23:59:59.999Z');
    expect(august.label).toBe('August 2026');
    expect(august.fileTag).toBe('2026-08');
  });

  it('range → from midnight to end of the To day', () => {
    const w = resolveReportWindow({ dateFrom: '2026-08-05', dateTo: '2026-08-07' }, NOW)!;
    expect(w.kind).toBe('range');
    expect(w.from.toISOString()).toBe('2026-08-05T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-08-07T23:59:59.999Z');
    expect(w.fileTag).toBe('2026-08-05_2026-08-07');
    expect(w.label).toContain('05 Aug 2026');
  });

  it('range with only dateTo runs from the epoch; only dateFrom runs to today', () => {
    const upTo = resolveReportWindow({ dateTo: '2026-08-07' }, NOW)!;
    expect(upTo.from.getUTCFullYear()).toBe(2000);
    const since = resolveReportWindow({ dateFrom: '2026-08-07' }, NOW)!;
    expect(since.to.toISOString()).toBe('2026-09-06T23:59:59.999Z');
  });

  it('all → all time', () => {
    const w = resolveReportWindow({ all: true }, NOW)!;
    expect(w.kind).toBe('all');
    expect(w.label).toBe('All time');
    expect(w.fileTag).toBe('all-time');
  });

  it('rejects garbage and inverted ranges, and nothing at all', () => {
    expect(resolveReportWindow({ month: '2026-13' }, NOW)).toBeNull();
    expect(resolveReportWindow({ dateFrom: '2026-08-10', dateTo: '2026-08-01' }, NOW)).toBeNull();
    expect(resolveReportWindow({ dateFrom: 'nope' }, NOW)).toBeNull();
    expect(resolveReportWindow({}, NOW)).toBeNull();
  });
});

describe('assembleFinanceReport', () => {
  const report = assembleFinanceReport({
    company: { name: 'Praxxel Technologies Pvt Ltd', address: 'Delhi' },
    window: august,
    rows,
    accounts,
    parties,
    now: NOW,
  });

  it('only counts rows inside the window', () => {
    expect(report.transactionCount).toBe(7);
    expect(report.transactions.map((t) => t.date.toISOString().slice(0, 10))).toEqual([
      '2026-08-01', '2026-08-05', '2026-08-10', '2026-08-12', '2026-08-20', '2026-08-25', '2026-08-31',
    ]);
  });

  it('splits operating P&L from financing cash flows', () => {
    expect(report.totals.income).toBe(20000);
    expect(report.totals.expense).toBe(6000 + 3000 + 2977 + 23);
    expect(report.totals.net).toBe(20000 - 12000);
    expect(report.totals.cashIn).toBe(30000);
    expect(report.totals.cashOut).toBe(17000);
    expect(report.financing).toEqual({
      loanReceived: 10000,
      investmentReceived: 0,
      loanRepaid: 0,
      cardRepaid: 5000,
    });
    expect(report.incomeByCategory.map((c) => c.category)).toEqual(['SALES']);
    expect(report.expenseByCategory.map((c) => c.category)).toEqual(['ADS', 'PAYOUT', 'SOFTWARE', 'BANK_CHARGES']);
    expect(report.financingByCategory.map((c) => c.category).sort()).toEqual(['CARD_REPAYMENT', 'LOAN_RECEIVED']);
  });

  it('computes account opening from history and closing from the window', () => {
    const yes = report.accounts.find((a) => a.id === YES)!;
    expect(yes.opening).toBe(6000); // 5000 + July sale 1000
    expect(yes.moneyIn).toBe(30000);
    expect(yes.moneyOut).toBe(8023);
    expect(yes.closing).toBe(6000 + 30000 - 8023);

    const card = report.accounts.find((a) => a.id === CARD)!;
    expect(card.opening).toBe(-4000);
    expect(card.moneyOut).toBe(8977);
    expect(card.closing).toBe(-12977);
  });

  it('party totals cover the window; owed covers everything up to the window end', () => {
    const shubham = report.parties.find((p) => p.id === SHUBHAM)!;
    expect(shubham.paidTo).toBe(5000);
    expect(shubham.receivedFrom).toBe(10000);
    // card spend 4000 (July) + 6000 + 2977 − repaid 5000 = 7977; loan 10000 → owed 17977
    expect(shubham.owedAtEnd).toBe(17977);

    const tinkal = report.parties.find((p) => p.id === TINKAL)!;
    expect(tinkal.paidTo).toBe(3000);
    expect(tinkal.owedAtEnd).toBe(0);

    expect(report.outstanding).toEqual([
      expect.objectContaining({ partyId: SHUBHAM, loanOutstanding: 10000, cardOutstanding: 7977, owed: 17977 }),
    ]);
  });

  it('maps transactions with labels, kinds and blank-safe strings', () => {
    const zego = report.transactions.find((t) => t.description === 'ZEGOCLOUD')!;
    expect(zego.categoryLabel).toBe('Software / hosting');
    expect(zego.kind).toBe('OPERATING');
    expect(zego.originalAmount).toBe(30);
    expect(zego.accountName).toBe('Shubham card');
    expect(zego.partyName).toBe('');
    const repay = report.transactions.find((t) => t.category === 'CARD_REPAYMENT')!;
    expect(repay.kind).toBe('FINANCING');
  });

  it('carries company and window through', () => {
    expect(report.company.name).toBe('Praxxel Technologies Pvt Ltd');
    expect(report.window.label).toBe('August 2026');
    expect(report.generatedAt).toBe(NOW);
    expect(reportFileStem(report)).toBe('praxxel-technologies-pvt-ltd-finance-2026-08');
  });
});

describe('companyFromSettings', () => {
  it('falls back to OfficePilot and trims', () => {
    expect(companyFromSettings([])).toEqual({ name: 'OfficePilot', address: '' });
    expect(
      companyFromSettings([
        { key: 'company_name', value: '  Praxxel ' },
        { key: 'company_address', value: ' Delhi ' },
      ]),
    ).toEqual({ name: 'Praxxel', address: 'Delhi' });
  });
});
