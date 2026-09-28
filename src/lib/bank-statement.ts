/**
 * Bank statement CSV → plain lines the reconciler can compare with the
 * ledger. Pure — no DB, no clock.
 *
 * Built for the YES BANK export, which looks like:
 *
 *   000261900007090 ,PRAXXEL TECHNOLOGIES PRIVATE LIMITED
 *   Statement Period,2026-08-01,To,2026-08-31,
 *   Opening Balance,INR 5096.82
 *   Closing Balance,INR 22456.05
 *   Transaction Date,Value Date,Description,Reference Number,Withdrawals,Deposits,Running Balance
 *   2026-08-31,2026-08-31,IMPS PAYMENT CHRGS for 29-Aug-2026,ORMB957221750355   ,7.00,,INR 22456.05
 *
 * but the header row is found by its column names, not its position, so
 * other banks' exports (Debit / Credit / Narration / Chq-Ref, DD/MM/YYYY
 * dates, Indian digit grouping) parse too.
 */

export interface StatementLine {
  /** 1-based position in the file's data rows, for display. */
  line: number;
  date: Date;
  direction: 'IN' | 'OUT';
  amount: number;
  description: string;
  reference: string;
  /** Balance the bank printed after this line, when the file has one. */
  balance: number | null;
}

export interface ParsedStatement {
  lines: StatementLine[];
  /** From the preamble when present; otherwise the first / last line dates. */
  periodFrom: Date | null;
  periodTo: Date | null;
  opening: number | null;
  closing: number | null;
  /** Rows that looked like data but could not be read. */
  skipped: { line: number; reason: string }[];
}

export class StatementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementParseError';
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** "INR 22,456.05" / "1,23,456.00 Cr" / "(500.00)" → number; blank → null. */
export function parseAmount(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === '' || s === '-') return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/\bDr\.?$/i.test(s)) negative = true;
  s = s.replace(/INR|Rs\.?|₹|Cr\.?|Dr\.?/gi, '').replace(/[,\s]/g, '');
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Math.round(Number(s) * 100) / 100;
  return negative ? -n : n;
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function utc(y: number, m: number, d: number): Date | null {
  if (y < 100) y += 2000;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return date;
}

/** 2026-08-31 · 31/08/2026 · 31-08-26 · 31-Aug-2026 · 31 Aug 2026 → UTC midnight. */
export function parseStatementDate(raw: string | undefined): Date | null {
  if (!raw) return null;
  const s = raw.trim().split(/\s+\d{1,2}:\d{2}/)[0]!.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return utc(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (m) return utc(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[\s/-]([A-Za-z]{3})[A-Za-z]*[\s/-](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    return month ? utc(+m[3]!, month, +m[1]!) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Statement
// ---------------------------------------------------------------------------

interface Columns {
  date: number;
  description: number;
  reference: number;
  debit: number;
  credit: number;
  balance: number;
}

const norm = (s: string) => s.trim().toLowerCase().replace(/[^a-z]/g, '');

function findColumns(header: string[]): Columns | null {
  const cells = header.map(norm);
  const find = (...names: string[]) => cells.findIndex((c) => names.some((n) => c === n || c.startsWith(n)));
  const date = find('transactiondate', 'txndate', 'trandate', 'date', 'postingdate');
  const debit = find('withdrawal', 'debit', 'withdrawalamt', 'dr');
  const credit = find('deposit', 'credit', 'depositamt', 'cr');
  if (date < 0 || debit < 0 || credit < 0) return null;
  return {
    date,
    debit,
    credit,
    description: find('description', 'narration', 'particulars', 'remarks', 'details'),
    reference: find('referencenumber', 'reference', 'refno', 'chqrefno', 'chequeno', 'utr'),
    balance: find('runningbalance', 'closingbalance', 'balance'),
  };
}

function preambleValue(rows: string[][], label: RegExp): string[] | null {
  for (const r of rows) {
    if (r[0] && label.test(r[0].trim())) return r.slice(1);
  }
  return null;
}

export function parseBankStatement(text: string): ParsedStatement {
  const rows = parseCsv(text);
  const headerIndex = rows.findIndex((r) => findColumns(r) !== null);
  if (headerIndex < 0) {
    throw new StatementParseError(
      'Could not find the column headings. The file needs a date column and withdrawal / deposit (or debit / credit) columns.',
    );
  }
  const cols = findColumns(rows[headerIndex]!)!;
  const preamble = rows.slice(0, headerIndex);

  const lines: StatementLine[] = [];
  const skipped: ParsedStatement['skipped'] = [];
  let n = 0;
  for (const r of rows.slice(headerIndex + 1)) {
    if (r.every((c) => c.trim() === '')) continue;
    n++;
    const date = parseStatementDate(r[cols.date]);
    const debit = parseAmount(r[cols.debit]);
    const credit = parseAmount(r[cols.credit]);
    if (!date) {
      // A footer ("Total", "*** End of statement ***") rather than a bad row.
      if (debit === null && credit === null) continue;
      skipped.push({ line: n, reason: `Unreadable date "${(r[cols.date] ?? '').trim()}"` });
      continue;
    }
    const out = debit !== null && debit !== 0 ? Math.abs(debit) : null;
    const inn = credit !== null && credit !== 0 ? Math.abs(credit) : null;
    if ((out === null) === (inn === null)) {
      skipped.push({ line: n, reason: 'Needs exactly one of withdrawal / deposit' });
      continue;
    }
    lines.push({
      line: n,
      date,
      direction: out !== null ? 'OUT' : 'IN',
      amount: (out ?? inn)!,
      description: cols.description >= 0 ? (r[cols.description] ?? '').trim() : '',
      reference: cols.reference >= 0 ? (r[cols.reference] ?? '').trim() : '',
      balance: cols.balance >= 0 ? parseAmount(r[cols.balance]) : null,
    });
  }

  if (lines.length === 0) {
    throw new StatementParseError('The file has headings but no transaction lines.');
  }

  const period = preambleValue(preamble, /^statement\s*period/i);
  const periodFrom = period ? parseStatementDate(period[0]) : null;
  const periodTo = period ? parseStatementDate(period.find((v, i) => i > 0 && parseStatementDate(v))) : null;
  const opening = parseAmount(preambleValue(preamble, /^opening\s*balance/i)?.[0]);
  const closing = parseAmount(preambleValue(preamble, /^closing\s*balance/i)?.[0]);

  const times = lines.map((l) => l.date.getTime());
  return {
    lines,
    periodFrom: periodFrom ?? new Date(Math.min(...times)),
    periodTo: periodTo ?? new Date(Math.max(...times)),
    opening,
    closing,
    skipped,
  };
}
