/**
 * Finance report → Excel workbook (ExcelJS).
 *
 * Three sheets, styled so it can go straight to the accountant:
 *   • Summary      — company header, P&L totals, category breakdowns,
 *                    financing flows, accounts, outstanding balances
 *   • Transactions — every row in the window with money-in / money-out
 *                    columns, frozen header, filters, totals
 *   • Parties      — paid / received per party and what we owe at period end
 */

import ExcelJS from 'exceljs';

import {
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_PARTY_TYPE_SHORT,
  formatDateUtc,
} from '@/lib/finance';

import type { FinanceReport } from './finance-report';

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const BRAND = 'FF4F46E5';
const BRAND_SOFT = 'FFEEF2FF';
const INK = 'FF111827';
const MUTED = 'FF6B7280';
const LINE = 'FFE5E7EB';
const GREEN_SOFT = 'FFDCFCE7';
const RED_SOFT = 'FFFEE2E2';
const GREEN = 'FF166534';
const RED = 'FF991B1B';

/** ₹ with Indian digit grouping; negatives get a leading minus. */
export const INR_NUMBER_FORMAT =
  '[>=10000000]"₹"##\\,##\\,##\\,##0.00;[>=100000]"₹"##\\,##\\,##0.00;"₹"#,##0.00';
const INT_FORMAT = '#,##0';
const DATE_FORMAT = 'dd-mmm-yyyy';

const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: LINE } };
const BORDER: Partial<ExcelJS.Borders> = { top: thin, bottom: thin, left: thin, right: thin };

function fill(argb: string): ExcelJS.Fill {
  return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function styleHeaderRow(row: ExcelJS.Row, count: number): void {
  for (let c = 1; c <= count; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    cell.fill = fill(BRAND);
    cell.alignment = { vertical: 'middle', horizontal: c === 1 ? 'left' : cell.alignment?.horizontal ?? 'left', wrapText: true };
    cell.border = BORDER;
  }
  row.height = 20;
}

function styleBodyRow(row: ExcelJS.Row, count: number, zebra: boolean): void {
  for (let c = 1; c <= count; c += 1) {
    const cell = row.getCell(c);
    cell.border = BORDER;
    cell.font = { size: 10, color: { argb: INK } };
    if (zebra) cell.fill = fill('FFF9FAFB');
  }
}

function styleTotalRow(row: ExcelJS.Row, count: number): void {
  for (let c = 1; c <= count; c += 1) {
    const cell = row.getCell(c);
    cell.font = { bold: true, size: 10, color: { argb: INK } };
    cell.fill = fill(BRAND_SOFT);
    cell.border = BORDER;
  }
}

function money(cell: ExcelJS.Cell): void {
  cell.numFmt = INR_NUMBER_FORMAT;
  cell.alignment = { horizontal: 'right' };
}

function sectionTitle(ws: ExcelJS.Worksheet, text: string): void {
  ws.addRow([]);
  const row = ws.addRow([text]);
  row.getCell(1).font = { bold: true, size: 12, color: { argb: BRAND } };
  row.height = 22;
}

function companyHeader(ws: ExcelJS.Worksheet, report: FinanceReport, subtitle: string, span: number): void {
  const last = String.fromCharCode(64 + span);
  const r1 = ws.addRow([report.company.name]);
  r1.getCell(1).font = { bold: true, size: 18, color: { argb: INK } };
  r1.height = 28;
  ws.mergeCells(`A1:${last}1`);

  const r2 = ws.addRow([report.company.address || ' ']);
  r2.getCell(1).font = { size: 10, color: { argb: MUTED } };
  ws.mergeCells(`A2:${last}2`);

  const r3 = ws.addRow([`${subtitle} · ${report.window.label}`]);
  r3.getCell(1).font = { bold: true, size: 13, color: { argb: BRAND } };
  r3.height = 22;
  ws.mergeCells(`A3:${last}3`);

  const r4 = ws.addRow([
    `Generated ${formatDateUtc(report.generatedAt)} by OfficePilot · all amounts in INR`,
  ]);
  r4.getCell(1).font = { italic: true, size: 9, color: { argb: MUTED } };
  ws.mergeCells(`A4:${last}4`);
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

function addSummarySheet(wb: ExcelJS.Workbook, report: FinanceReport): void {
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.columns = [
    { width: 38 },
    { width: 14 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
  ];
  companyHeader(ws, report, 'Finance report', 7);

  // -- Totals --------------------------------------------------------------
  sectionTitle(ws, 'Summary');
  const kpis: Array<[string, number, string | undefined]> = [
    ['Income (operating)', report.totals.income, GREEN_SOFT],
    ['Expense (operating)', report.totals.expense, RED_SOFT],
    ['Net (income − expense)', report.totals.net, report.totals.net >= 0 ? GREEN_SOFT : RED_SOFT],
    ['Total money in (incl. loans / investment)', report.totals.cashIn, undefined],
    ['Total money out (incl. repayments)', report.totals.cashOut, undefined],
  ];
  for (const [label, value, bg] of kpis) {
    const row = ws.addRow([label, value]);
    styleBodyRow(row, 2, false);
    money(row.getCell(2));
    row.getCell(1).font = { size: 10, bold: true, color: { argb: INK } };
    if (bg) {
      row.getCell(2).fill = fill(bg);
      row.getCell(2).font = {
        bold: true,
        size: 10,
        color: { argb: bg === GREEN_SOFT ? GREEN : RED },
      };
    }
  }
  const countRow = ws.addRow(['Transactions in period', report.transactionCount]);
  styleBodyRow(countRow, 2, false);
  countRow.getCell(2).numFmt = INT_FORMAT;
  countRow.getCell(2).alignment = { horizontal: 'right' };

  // -- Category tables -----------------------------------------------------
  const categoryTable = (title: string, rows: FinanceReport['incomeByCategory']) => {
    sectionTitle(ws, title);
    const head = ws.addRow(['Category', 'Entries', 'Amount']);
    styleHeaderRow(head, 3);
    head.getCell(2).alignment = { horizontal: 'right' };
    head.getCell(3).alignment = { horizontal: 'right' };
    if (rows.length === 0) {
      const empty = ws.addRow(['— none —', 0, 0]);
      styleBodyRow(empty, 3, false);
      empty.getCell(2).numFmt = INT_FORMAT;
      money(empty.getCell(3));
      return;
    }
    rows.forEach((c, i) => {
      const row = ws.addRow([c.label, c.count, c.amount]);
      styleBodyRow(row, 3, i % 2 === 1);
      row.getCell(2).numFmt = INT_FORMAT;
      row.getCell(2).alignment = { horizontal: 'right' };
      money(row.getCell(3));
    });
    const total = ws.addRow([
      'Total',
      rows.reduce((s, c) => s + c.count, 0),
      Math.round(rows.reduce((s, c) => s + c.amount, 0) * 100) / 100,
    ]);
    styleTotalRow(total, 3);
    total.getCell(2).numFmt = INT_FORMAT;
    total.getCell(2).alignment = { horizontal: 'right' };
    money(total.getCell(3));
  };
  categoryTable('Income by category', report.incomeByCategory);
  categoryTable('Expense by category', report.expenseByCategory);

  // -- Financing -----------------------------------------------------------
  sectionTitle(ws, 'Loans & card settlements (cash moved, not profit or loss)');
  const fHead = ws.addRow(['Flow', '', 'Amount']);
  styleHeaderRow(fHead, 3);
  fHead.getCell(3).alignment = { horizontal: 'right' };
  const flows: Array<[string, number]> = [
    ['Loans received', report.financing.loanReceived],
    ['Investment received', report.financing.investmentReceived],
    ['Loan repayments', report.financing.loanRepaid],
    ['Card repayments (settling borrowed cards)', report.financing.cardRepaid],
  ];
  flows.forEach(([label, value], i) => {
    const row = ws.addRow([label, '', value]);
    styleBodyRow(row, 3, i % 2 === 1);
    money(row.getCell(3));
  });

  // -- Accounts ------------------------------------------------------------
  sectionTitle(ws, 'Accounts');
  const aHead = ws.addRow(['Account', 'Type', 'Belongs to', 'Opening', 'Money in', 'Money out', 'Closing']);
  styleHeaderRow(aHead, 7);
  for (let c = 4; c <= 7; c += 1) aHead.getCell(c).alignment = { horizontal: 'right' };
  report.accounts.forEach((a, i) => {
    const row = ws.addRow([
      a.name,
      FINANCE_ACCOUNT_TYPE_LABELS[a.type],
      a.ownerName ?? 'Company',
      a.opening,
      a.moneyIn,
      a.moneyOut,
      a.closing,
    ]);
    styleBodyRow(row, 7, i % 2 === 1);
    for (let c = 4; c <= 7; c += 1) money(row.getCell(c));
  });

  // -- Outstanding ---------------------------------------------------------
  sectionTitle(ws, `Outstanding at end of period (what we owe)`);
  const oHead = ws.addRow(['Party', 'Type', 'Loan outstanding', 'Card outstanding', 'Total we owe']);
  styleHeaderRow(oHead, 5);
  for (let c = 3; c <= 5; c += 1) oHead.getCell(c).alignment = { horizontal: 'right' };
  if (report.outstanding.length === 0) {
    const row = ws.addRow(['— nothing outstanding —', '', 0, 0, 0]);
    styleBodyRow(row, 5, false);
    for (let c = 3; c <= 5; c += 1) money(row.getCell(c));
  }
  report.outstanding.forEach((o, i) => {
    const row = ws.addRow([
      o.name,
      FINANCE_PARTY_TYPE_SHORT[o.type],
      o.loanOutstanding,
      o.cardOutstanding,
      o.owed,
    ]);
    styleBodyRow(row, 5, i % 2 === 1);
    for (let c = 3; c <= 5; c += 1) money(row.getCell(c));
    row.getCell(5).font = { bold: true, size: 10, color: { argb: o.owed > 0 ? RED : GREEN } };
  });
}

function addTransactionsSheet(wb: ExcelJS.Workbook, report: FinanceReport): void {
  const ws = wb.addWorksheet('Transactions', {
    views: [{ state: 'frozen', ySplit: 6, showGridLines: false }],
  });
  ws.columns = [
    { width: 13 }, // Date
    { width: 11 }, // Type
    { width: 22 }, // Category
    { width: 44 }, // Description
    { width: 28 }, // Party
    { width: 22 }, // Via
    { width: 30 }, // Account
    { width: 24 }, // Reference
    { width: 16 }, // Money in
    { width: 16 }, // Money out
    { width: 14 }, // Original amount
    { width: 9 },  // Currency
  ];
  companyHeader(ws, report, 'Transactions', 12);
  ws.addRow([]);

  const headers = [
    'Date',
    'Type',
    'Category',
    'Description',
    'Party',
    'Routed via',
    'Account',
    'Reference',
    'Money in',
    'Money out',
    'Original amt',
    'Currency',
  ];
  const head = ws.addRow(headers);
  styleHeaderRow(head, headers.length);
  for (const c of [9, 10, 11]) head.getCell(c).alignment = { horizontal: 'right' };
  const firstDataRow = head.number + 1;

  report.transactions.forEach((t, i) => {
    const row = ws.addRow([
      t.date,
      t.direction === 'IN' ? 'Money in' : 'Money out',
      t.kind === 'FINANCING' ? `${t.categoryLabel} (not P&L)` : t.categoryLabel,
      t.description,
      t.partyName,
      t.viaPartyName,
      t.accountName,
      t.reference,
      t.direction === 'IN' ? t.amount : null,
      t.direction === 'OUT' ? t.amount : null,
      t.originalAmount ?? null,
      t.originalCurrency ?? '',
    ]);
    styleBodyRow(row, headers.length, i % 2 === 1);
    row.getCell(1).numFmt = DATE_FORMAT;
    row.getCell(1).alignment = { horizontal: 'left' };
    row.getCell(2).font = {
      size: 10,
      bold: true,
      color: { argb: t.direction === 'IN' ? GREEN : RED },
    };
    if (t.viaPartyName) {
      row.getCell(6).font = { size: 10, italic: true, color: { argb: MUTED } };
    }
    money(row.getCell(9));
    money(row.getCell(10));
    row.getCell(11).numFmt = '#,##0.00';
    row.getCell(11).alignment = { horizontal: 'right' };
  });

  const lastDataRow = ws.rowCount;
  if (report.transactions.length === 0) {
    const empty = ws.addRow(['No transactions in this period']);
    styleBodyRow(empty, headers.length, false);
  }
  const totalIn = report.transactions
    .filter((t) => t.direction === 'IN')
    .reduce((s, t) => s + t.amount, 0);
  const totalOut = report.transactions
    .filter((t) => t.direction === 'OUT')
    .reduce((s, t) => s + t.amount, 0);
  const totals = ws.addRow([
    'Total',
    '',
    '',
    `${report.transactionCount} transactions`,
    '',
    '',
    '',
    '',
    report.transactions.length > 0
      ? { formula: `SUM(I${firstDataRow}:I${lastDataRow})`, result: Math.round(totalIn * 100) / 100 }
      : 0,
    report.transactions.length > 0
      ? { formula: `SUM(J${firstDataRow}:J${lastDataRow})`, result: Math.round(totalOut * 100) / 100 }
      : 0,
    '',
    '',
  ]);
  styleTotalRow(totals, headers.length);
  money(totals.getCell(9));
  money(totals.getCell(10));

  ws.autoFilter = {
    from: { row: head.number, column: 1 },
    to: { row: Math.max(head.number, lastDataRow), column: headers.length },
  };
}

function addPartiesSheet(wb: ExcelJS.Workbook, report: FinanceReport): void {
  const ws = wb.addWorksheet('Parties', { views: [{ showGridLines: false }] });
  ws.columns = [{ width: 38 }, { width: 16 }, { width: 18 }, { width: 18 }, { width: 20 }];
  companyHeader(ws, report, 'Parties', 5);
  ws.addRow([]);
  const head = ws.addRow(['Party', 'Type', 'Paid to them', 'Received from them', 'We owe (period end)']);
  styleHeaderRow(head, 5);
  for (let c = 3; c <= 5; c += 1) head.getCell(c).alignment = { horizontal: 'right' };
  report.parties.forEach((p, i) => {
    const row = ws.addRow([
      p.name,
      FINANCE_PARTY_TYPE_SHORT[p.type],
      p.paidTo,
      p.receivedFrom,
      p.owedAtEnd,
    ]);
    styleBodyRow(row, 5, i % 2 === 1);
    for (let c = 3; c <= 5; c += 1) money(row.getCell(c));
    if (p.owedAtEnd !== 0) {
      row.getCell(5).font = { bold: true, size: 10, color: { argb: p.owedAtEnd > 0 ? RED : GREEN } };
    }
  });
  if (report.parties.length === 0) {
    const empty = ws.addRow(['No party activity in this period']);
    styleBodyRow(empty, 5, false);
  }
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function buildFinanceReportXlsx(report: FinanceReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'OfficePilot';
  wb.created = report.generatedAt;
  wb.modified = report.generatedAt;

  addSummarySheet(wb, report);
  addTransactionsSheet(wb, report);
  addPartiesSheet(wb, report);

  const data = await wb.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}
