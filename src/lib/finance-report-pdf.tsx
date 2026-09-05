/**
 * Finance report → PDF (@react-pdf/renderer).
 *
 * Page 1+ (portrait): company header band, KPI tiles, income / expense by
 * category, financing flows, accounts, outstanding balances.
 * Then (landscape): the full transaction list with a header row that
 * repeats on every page. Every page carries a footer with page numbers.
 *
 * Noto Sans (OFL, in `public/fonts`) is registered so the rupee sign
 * renders; if the files are missing (unusual deploy layout) we fall back
 * to Helvetica and print "Rs" instead of "₹".
 */

import fs from 'node:fs';
import path from 'node:path';
import * as React from 'react';
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from '@react-pdf/renderer';

import {
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_PARTY_TYPE_SHORT,
  formatDateUtc,
  formatInr,
} from '@/lib/finance';

import type { FinanceReport } from './finance-report';

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

let fontFamily = 'Helvetica';
let rupeeOk = false;
let fontsInitialised = false;

function ensureFonts(): void {
  if (fontsInitialised) return;
  fontsInitialised = true;
  const dir = path.join(process.cwd(), 'public', 'fonts');
  const regular = path.join(dir, 'NotoSans-Regular.ttf');
  const bold = path.join(dir, 'NotoSans-Bold.ttf');
  if (fs.existsSync(regular) && fs.existsSync(bold)) {
    Font.register({
      family: 'NotoSans',
      fonts: [
        { src: regular },
        { src: bold, fontWeight: 700 },
      ],
    });
    fontFamily = 'NotoSans';
    rupeeOk = true;
  }
  Font.registerHyphenationCallback((word) => [word]);
}

function money(value: number): string {
  const s = formatInr(value);
  return rupeeOk ? s : s.replace('₹', 'Rs ');
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const BRAND = '#4F46E5';
const INK = '#111827';
const MUTED = '#6B7280';
const LINE = '#E5E7EB';
const SOFT = '#F5F3FF';
const GREEN = '#166534';
const RED = '#991B1B';

const styles = StyleSheet.create({
  page: {
    paddingTop: 28,
    paddingBottom: 40,
    paddingHorizontal: 32,
    fontSize: 9,
    color: INK,
  },
  band: {
    backgroundColor: BRAND,
    borderRadius: 6,
    paddingVertical: 14,
    paddingHorizontal: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 14,
  },
  company: { color: '#FFFFFF', fontSize: 16, fontWeight: 700 },
  address: { color: '#E0E7FF', fontSize: 8.5, marginTop: 3, maxWidth: 320 },
  reportTitle: { color: '#FFFFFF', fontSize: 12, fontWeight: 700, textAlign: 'right' },
  reportMeta: { color: '#E0E7FF', fontSize: 8.5, marginTop: 3, textAlign: 'right' },
  kpiRow: { flexDirection: 'row', gap: 8, marginBottom: 14 },
  kpi: {
    flex: 1,
    borderWidth: 1,
    borderColor: LINE,
    borderRadius: 6,
    padding: 10,
  },
  kpiLabel: { fontSize: 8, color: MUTED, marginBottom: 4 },
  kpiValue: { fontSize: 13, fontWeight: 700 },
  section: { fontSize: 11, fontWeight: 700, color: BRAND, marginTop: 10, marginBottom: 6 },
  table: { borderWidth: 1, borderColor: LINE, borderRadius: 4, overflow: 'hidden' },
  thead: { flexDirection: 'row', backgroundColor: BRAND },
  th: { color: '#FFFFFF', fontWeight: 700, fontSize: 8.5, paddingVertical: 5, paddingHorizontal: 6 },
  tr: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: LINE },
  trZebra: { backgroundColor: '#FAFAFA' },
  td: { fontSize: 8.5, paddingVertical: 4, paddingHorizontal: 6 },
  total: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: LINE, backgroundColor: SOFT },
  totalTd: { fontSize: 8.5, fontWeight: 700, paddingVertical: 5, paddingHorizontal: 6 },
  right: { textAlign: 'right' },
  muted: { color: MUTED },
  green: { color: GREEN },
  red: { color: RED },
  footer: {
    position: 'absolute',
    bottom: 18,
    left: 32,
    right: 32,
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontSize: 7.5,
    color: MUTED,
    borderTopWidth: 1,
    borderTopColor: LINE,
    paddingTop: 5,
  },
  empty: { fontSize: 8.5, color: MUTED, padding: 8 },
});

// ---------------------------------------------------------------------------
// Table primitive
// ---------------------------------------------------------------------------

interface Col {
  key: string;
  label: string;
  width: number;
  align?: 'left' | 'right';
}

type Cell = string | { text: string; tone?: 'green' | 'red' | 'muted' };

/** react-pdf's `Style`, derived from `StyleSheet.create` so no extra import is needed. */
type PdfStyle = Parameters<typeof StyleSheet.create>[0][string];

function cellStyle(col: Col, base: PdfStyle, cell: Cell): PdfStyle[] {
  const tone = typeof cell === 'string' ? undefined : cell.tone;
  const out: PdfStyle[] = [base, { width: col.width }];
  if (col.align === 'right') out.push(styles.right);
  if (tone === 'green') out.push(styles.green);
  else if (tone === 'red') out.push(styles.red);
  else if (tone === 'muted') out.push(styles.muted);
  return out;
}

function Table({
  cols,
  rows,
  total,
  repeatHeader = false,
  emptyText = 'Nothing to show',
}: {
  cols: Col[];
  rows: Array<Record<string, Cell>>;
  total?: Record<string, Cell>;
  repeatHeader?: boolean;
  emptyText?: string;
}) {
  return (
    <View style={styles.table}>
      <View style={styles.thead} fixed={repeatHeader}>
        {cols.map((c) => (
          <Text key={c.key} style={[styles.th, { width: c.width }, c.align === 'right' ? styles.right : {}]}>
            {c.label}
          </Text>
        ))}
      </View>
      {rows.length === 0 ? <Text style={styles.empty}>{emptyText}</Text> : null}
      {rows.map((r, i) => (
        <View key={i} style={[styles.tr, i % 2 === 1 ? styles.trZebra : {}]} wrap={false}>
          {cols.map((c) => {
            const cell = r[c.key] ?? '';
            return (
              <Text key={c.key} style={cellStyle(c, styles.td, cell)}>
                {typeof cell === 'string' ? cell : cell.text}
              </Text>
            );
          })}
        </View>
      ))}
      {total ? (
        <View style={styles.total} wrap={false}>
          {cols.map((c) => {
            const cell = total[c.key] ?? '';
            return (
              <Text key={c.key} style={cellStyle(c, styles.totalTd, cell)}>
                {typeof cell === 'string' ? cell : cell.text}
              </Text>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

function Footer({ report }: { report: FinanceReport }) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {report.company.name} · Finance report · {report.window.label}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Generated ${formatDateUtc(report.generatedAt)} by OfficePilot · Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------

function ReportDocument({ report }: { report: FinanceReport }) {
  const sum = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100) / 100;
  const catCols: Col[] = [
    { key: 'label', label: 'Category', width: 300 },
    { key: 'count', label: 'Entries', width: 80, align: 'right' },
    { key: 'amount', label: 'Amount', width: 151, align: 'right' },
  ];
  const catRows = (rows: FinanceReport['incomeByCategory']) =>
    rows.map((c) => ({ label: c.label, count: String(c.count), amount: money(c.amount) }));
  const catTotal = (rows: FinanceReport['incomeByCategory']) => ({
    label: 'Total',
    count: String(rows.reduce((s, c) => s + c.count, 0)),
    amount: money(sum(rows.map((c) => c.amount))),
  });

  const totalIn = sum(report.transactions.filter((t) => t.direction === 'IN').map((t) => t.amount));
  const totalOut = sum(report.transactions.filter((t) => t.direction === 'OUT').map((t) => t.amount));

  return (
    <Document
      title={`${report.company.name} — Finance report — ${report.window.label}`}
      author="OfficePilot"
      creator="OfficePilot"
    >
      {/* ---------------- Summary (portrait) ---------------- */}
      <Page size="A4" style={[styles.page, { fontFamily }]}>
        <View style={styles.band}>
          <View>
            <Text style={styles.company}>{report.company.name}</Text>
            {report.company.address ? <Text style={styles.address}>{report.company.address}</Text> : null}
          </View>
          <View>
            <Text style={styles.reportTitle}>Finance report</Text>
            <Text style={styles.reportMeta}>{report.window.label}</Text>
            <Text style={styles.reportMeta}>
              {formatDateUtc(report.window.from)} to {formatDateUtc(report.window.to)}
            </Text>
          </View>
        </View>

        <View style={styles.kpiRow}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Income</Text>
            <Text style={[styles.kpiValue, styles.green]}>{money(report.totals.income)}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Expense</Text>
            <Text style={[styles.kpiValue, styles.red]}>{money(report.totals.expense)}</Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Net</Text>
            <Text style={[styles.kpiValue, report.totals.net >= 0 ? styles.green : styles.red]}>
              {money(report.totals.net)}
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Money in / out (all)</Text>
            <Text style={styles.kpiValue}>{money(report.totals.cashIn)}</Text>
            <Text style={[styles.kpiLabel, { marginTop: 2 }]}>{money(report.totals.cashOut)} out</Text>
          </View>
        </View>

        <Text style={styles.section}>Income by category</Text>
        <Table cols={catCols} rows={catRows(report.incomeByCategory)} total={catTotal(report.incomeByCategory)} emptyText="No income in this period" />

        <Text style={styles.section}>Expense by category</Text>
        <Table cols={catCols} rows={catRows(report.expenseByCategory)} total={catTotal(report.expenseByCategory)} emptyText="No expenses in this period" />

        <Text style={styles.section}>Loans &amp; card settlements (cash moved, not profit or loss)</Text>
        <Table
          cols={[
            { key: 'label', label: 'Flow', width: 380 },
            { key: 'amount', label: 'Amount', width: 151, align: 'right' },
          ]}
          rows={[
            { label: 'Loans received', amount: money(report.financing.loanReceived) },
            { label: 'Investment received', amount: money(report.financing.investmentReceived) },
            { label: 'Loan repayments', amount: money(report.financing.loanRepaid) },
            { label: 'Card repayments (settling borrowed cards)', amount: money(report.financing.cardRepaid) },
          ]}
        />

        <Text style={styles.section}>Accounts</Text>
        <Table
          cols={[
            { key: 'name', label: 'Account', width: 150 },
            { key: 'type', label: 'Type', width: 70 },
            { key: 'owner', label: 'Belongs to', width: 87 },
            { key: 'opening', label: 'Opening', width: 56, align: 'right' },
            { key: 'in', label: 'Money in', width: 56, align: 'right' },
            { key: 'out', label: 'Money out', width: 56, align: 'right' },
            { key: 'closing', label: 'Closing', width: 56, align: 'right' },
          ]}
          rows={report.accounts.map((a) => ({
            name: a.name,
            type: FINANCE_ACCOUNT_TYPE_LABELS[a.type],
            owner: a.ownerName ?? 'Company',
            opening: money(a.opening),
            in: money(a.moneyIn),
            out: money(a.moneyOut),
            closing: { text: money(a.closing), tone: a.closing < 0 ? 'red' : undefined },
          }))}
          emptyText="No accounts"
        />

        <Text style={styles.section}>Outstanding at end of period (what we owe)</Text>
        <Table
          cols={[
            { key: 'name', label: 'Party', width: 220 },
            { key: 'type', label: 'Type', width: 80 },
            { key: 'loan', label: 'Loan outstanding', width: 77, align: 'right' },
            { key: 'card', label: 'Card outstanding', width: 77, align: 'right' },
            { key: 'owed', label: 'Total we owe', width: 77, align: 'right' },
          ]}
          rows={report.outstanding.map((o) => ({
            name: o.name,
            type: FINANCE_PARTY_TYPE_SHORT[o.type],
            loan: money(o.loanOutstanding),
            card: money(o.cardOutstanding),
            owed: { text: money(o.owed), tone: o.owed > 0 ? 'red' : 'green' },
          }))}
          emptyText="Nothing outstanding"
        />

        <Text style={styles.section}>Parties in this period</Text>
        <Table
          cols={[
            { key: 'name', label: 'Party', width: 220 },
            { key: 'type', label: 'Type', width: 80 },
            { key: 'paid', label: 'Paid to them', width: 77, align: 'right' },
            { key: 'recv', label: 'Received', width: 77, align: 'right' },
            { key: 'owed', label: 'We owe', width: 77, align: 'right' },
          ]}
          rows={report.parties.map((p) => ({
            name: p.name,
            type: FINANCE_PARTY_TYPE_SHORT[p.type],
            paid: money(p.paidTo),
            recv: money(p.receivedFrom),
            owed: { text: money(p.owedAtEnd), tone: p.owedAtEnd > 0 ? 'red' : p.owedAtEnd < 0 ? 'green' : 'muted' },
          }))}
          emptyText="No party activity"
        />

        <Footer report={report} />
      </Page>

      {/* ---------------- Transactions (landscape) ---------------- */}
      <Page size="A4" orientation="landscape" style={[styles.page, { fontFamily }]}>
        <Text style={[styles.section, { marginTop: 0 }]}>
          Transactions · {report.window.label} · {report.transactionCount} entries
        </Text>
        <Table
          repeatHeader
          cols={[
            { key: 'date', label: 'Date', width: 74 },
            { key: 'type', label: 'Type', width: 40 },
            { key: 'cat', label: 'Category', width: 100 },
            { key: 'desc', label: 'Description', width: 192 },
            { key: 'party', label: 'Party', width: 108 },
            { key: 'acct', label: 'Account', width: 108 },
            { key: 'ref', label: 'Reference', width: 90 },
            { key: 'in', label: 'Money in', width: 64, align: 'right' },
            { key: 'out', label: 'Money out', width: 64, align: 'right' },
          ]}
          rows={report.transactions.map((t) => ({
            date: formatDateUtc(t.date),
            type: { text: t.direction === 'IN' ? 'In' : 'Out', tone: t.direction === 'IN' ? 'green' : 'red' },
            cat: t.kind === 'FINANCING' ? `${t.categoryLabel} (not P&L)` : t.categoryLabel,
            desc:
              t.originalAmount !== null &&
              t.originalCurrency &&
              !t.description.includes(String(t.originalAmount))
                ? `${t.description}${t.description ? ' ' : ''}(${t.originalAmount} ${t.originalCurrency})`
                : t.description,
            party: t.partyName,
            acct: t.accountName,
            ref: { text: t.reference, tone: 'muted' },
            in: t.direction === 'IN' ? money(t.amount) : '',
            out: t.direction === 'OUT' ? money(t.amount) : '',
          }))}
          total={{
            date: 'Total',
            desc: `${report.transactionCount} transactions`,
            in: money(totalIn),
            out: money(totalOut),
          }}
          emptyText="No transactions in this period"
        />
        <Footer report={report} />
      </Page>
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function buildFinanceReportPdf(report: FinanceReport): Promise<Buffer> {
  ensureFonts();
  const buffer = await renderToBuffer(<ReportDocument report={report} />);
  return Buffer.from(buffer);
}
