import { describe, expect, it } from 'vitest';

import {
  MAX_STATEMENT_LINES,
  StatementParseError,
  parseAmount,
  parseBankStatement,
  parseCsv,
  parseStatementDate,
} from './bank-statement';

const at = (s: string) => new Date(`${s}T00:00:00.000Z`);

// The shape of the real YES BANK export: preamble, newest first, "INR"
// balances, references padded with spaces, CRLF line ends.
const YES_BANK = [
  '000261900007090 ,PRAXXEL TECHNOLOGIES PRIVATE LIMITED',
  '',
  'Statement Period,2026-08-01,To,2026-08-31,',
  'Opening Balance,INR 5096.82',
  'Closing Balance,INR 22456.05',
  'Transaction Date,Value Date,Description,Reference Number,Withdrawals,Deposits,Running Balance',
  '2026-08-31,2026-08-31,IMPS PAYMENT CHRGS for 29-Aug-2026,ORMB957221750355                        ,7.00,,INR 22456.05',
  '2026-08-31,2026-08-31,GST,ORMB957221750355                        ,1.26,,INR 22463.05',
  '2026-08-31,2026-08-31,NEFT-HDFCH01226138594-CASHFREE PAYMENTS,HDFCH01226138594,,8046.34,INR 22464.31',
  '2026-08-01,2026-08-01,NEFT-HDFCH01163858230-CASHFREE PAYMENTS,HDFCH01163858230,,231.54,INR 5328.36',
].join('\r\n');

describe('parseAmount', () => {
  it('reads bank formats', () => {
    expect(parseAmount('INR 22456.05')).toBe(22456.05);
    expect(parseAmount('1,23,456.00')).toBe(123456);
    expect(parseAmount('₹ 500')).toBe(500);
    expect(parseAmount('(250.50)')).toBe(-250.5);
    expect(parseAmount('1,000.00 Dr')).toBe(-1000);
    expect(parseAmount('1,000.00 Cr')).toBe(1000);
  });

  it('treats blanks as no value, not zero', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('parseStatementDate', () => {
  it('reads the common layouts as UTC midnight', () => {
    expect(parseStatementDate('2026-08-31')).toEqual(at('2026-08-31'));
    expect(parseStatementDate('31/08/2026')).toEqual(at('2026-08-31'));
    expect(parseStatementDate('31-08-26')).toEqual(at('2026-08-31'));
    expect(parseStatementDate('31-Aug-2026')).toEqual(at('2026-08-31'));
    expect(parseStatementDate('31 Aug 2026')).toEqual(at('2026-08-31'));
    expect(parseStatementDate('31/08/2026 14:22:10')).toEqual(at('2026-08-31'));
  });

  it('rejects impossible dates instead of rolling them over', () => {
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('2026-13-01')).toBeNull();
    expect(parseStatementDate('Total')).toBeNull();
  });
});

describe('parseCsv', () => {
  it('keeps commas inside quoted narrations', () => {
    expect(parseCsv('a,"b, c",d\r\n"x ""y""",,z')).toEqual([
      ['a', 'b, c', 'd'],
      ['x "y"', '', 'z'],
    ]);
  });
});

describe('parseBankStatement — YES BANK', () => {
  const s = parseBankStatement(YES_BANK);

  it('reads the preamble', () => {
    expect(s.periodFrom).toEqual(at('2026-08-01'));
    expect(s.periodTo).toEqual(at('2026-08-31'));
    expect(s.opening).toBe(5096.82);
    expect(s.closing).toBe(22456.05);
  });

  it('reads every line with direction, trimmed reference and balance', () => {
    expect(s.lines).toHaveLength(4);
    expect(s.lines[0]).toMatchObject({
      line: 1,
      date: at('2026-08-31'),
      direction: 'OUT',
      amount: 7,
      description: 'IMPS PAYMENT CHRGS for 29-Aug-2026',
      reference: 'ORMB957221750355',
      balance: 22456.05,
    });
    expect(s.lines[2]).toMatchObject({ direction: 'IN', amount: 8046.34 });
    expect(s.skipped).toEqual([]);
  });
});

describe('parseBankStatement — other layouts', () => {
  it('reads Debit / Credit / Narration with DD/MM/YYYY and no preamble', () => {
    const s = parseBankStatement(
      [
        'Date,Narration,Chq./Ref.No.,Debit,Credit,Balance',
        '01/09/2026,"UPI/FACEBOOK, INC/123",UPI123,"10,000.00",,"40,000.00"',
        '02/09/2026,SALARY CREDIT,,,"5,000.00","45,000.00"',
        'Total,,,,"10,000.00","5,000.00"',
      ].join('\n'),
    );
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toMatchObject({
      direction: 'OUT',
      amount: 10000,
      description: 'UPI/FACEBOOK, INC/123',
      reference: 'UPI123',
    });
    expect(s.periodFrom).toEqual(at('2026-09-01'));
    expect(s.periodTo).toEqual(at('2026-09-02'));
    expect(s.opening).toBeNull();
  });

  it('reports a line it cannot read instead of guessing', () => {
    const s = parseBankStatement(
      ['Date,Description,Withdrawal,Deposit', '2026-09-01,both,5.00,5.00', '2026-09-02,ok,1.00,'].join(
        '\n',
      ),
    );
    expect(s.lines).toHaveLength(1);
    expect(s.skipped).toEqual([{ line: 1, reason: 'Needs exactly one of withdrawal / deposit' }]);
  });

  it('says so when the headings are missing', () => {
    expect(() => parseBankStatement('just,some,text\n1,2,3')).toThrow(StatementParseError);
  });
});

describe('parseBankStatement — hostile input', () => {
  it('reads a padded cell in linear time and refuses it as a date', () => {
    const started = Date.now();
    expect(parseStatementDate(`a${' '.repeat(200_000)}b`)).toBeNull();
    expect(parseAmount(' '.repeat(200_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('refuses a file with more lines than any month has', () => {
    const rows = ['Date,Description,Withdrawal,Deposit'];
    for (let i = 0; i <= MAX_STATEMENT_LINES; i++) rows.push('2026-09-01,x,1.00,');
    expect(() => parseBankStatement(rows.join('\n'))).toThrow(/one month at a time/);
  });
});
