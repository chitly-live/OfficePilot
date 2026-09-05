/**
 * Finance report — the data behind the Excel / PDF exports the admin hands
 * to the accountant.
 *
 * `assembleFinanceReport` is pure (unit-tested); `buildFinanceReport` loads
 * the rows from Prisma and calls it. The report covers one window (a month,
 * a date range, or all time) and includes:
 *
 *   • P&L totals (operating income / expense / net) and gross cash movement
 *   • income and expense by category, financing flows (loans, card settlements)
 *   • per-account opening / in / out / closing for the window
 *   • per-party paid / received in the window and what we still owe them
 *   • the full transaction list for the window
 */

import type {
  FinanceAccountType,
  FinanceCategory,
  FinanceDirection,
  FinancePartyType,
  PrismaClient,
} from '@prisma/client';

import {
  FINANCE_CATEGORY_META,
  computeAccountBalance,
  computePartyBalance,
  formatDateUtc,
  groupByCategory,
  monthLabel,
  monthRange,
  parseDateOnly,
  round2,
  summarizeRows,
  toDateKey,
  type CategoryTotal,
  type FinanceCategoryKind,
  type FinanceTotals,
  type LedgerRow,
} from '@/lib/finance';

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

export type ReportWindowKind = 'month' | 'range' | 'all';

export interface ReportWindow {
  kind: ReportWindowKind;
  /** Inclusive UTC bounds. */
  from: Date;
  to: Date;
  /** Human label, e.g. "August 2026", "1 Aug 2026 – 15 Aug 2026", "All time". */
  label: string;
  /** Safe for filenames, e.g. "2026-08", "2026-08-01_2026-08-15", "all-time". */
  fileTag: string;
}

const EPOCH_UTC = new Date(Date.UTC(2000, 0, 1));

function endOfUtcDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999),
  );
}

export interface ReportWindowInput {
  month?: string;
  dateFrom?: string;
  dateTo?: string;
  all?: boolean;
}

/** `null` when the input doesn't describe a usable window. */
export function resolveReportWindow(
  input: ReportWindowInput,
  now: Date = new Date(),
): ReportWindow | null {
  if (input.all) {
    return {
      kind: 'all',
      from: EPOCH_UTC,
      to: endOfUtcDay(now),
      label: 'All time',
      fileTag: 'all-time',
    };
  }
  if (input.month) {
    const range = monthRange(input.month);
    if (!range) return null;
    return {
      kind: 'month',
      from: range.from,
      to: range.to,
      label: monthLabel(input.month),
      fileTag: input.month.trim(),
    };
  }
  if (input.dateFrom || input.dateTo) {
    const from = input.dateFrom ? parseDateOnly(input.dateFrom) : EPOCH_UTC;
    const toDay = input.dateTo ? parseDateOnly(input.dateTo) : now;
    if (!from || !toDay) return null;
    const to = endOfUtcDay(toDay);
    if (to.getTime() < from.getTime()) return null;
    return {
      kind: 'range',
      from,
      to,
      label: `${formatDateUtc(from)} – ${formatDateUtc(to)}`,
      fileTag: `${toDateKey(from)}_${toDateKey(to)}`,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ReportCompany {
  name: string;
  address: string;
}

export interface ReportSourceRow extends LedgerRow {
  id: string;
  date: Date;
  originalAmount: number | null;
  originalCurrency: string | null;
  description: string | null;
  reference: string | null;
  partyName: string | null;
  accountName: string | null;
}

export interface ReportSourceAccount {
  id: string;
  name: string;
  type: FinanceAccountType;
  openingBalance: number;
  ownerPartyId: string | null;
  ownerName: string | null;
  isActive: boolean;
}

export interface ReportSourceParty {
  id: string;
  name: string;
  type: FinancePartyType;
}

export interface ReportTransaction {
  id: string;
  date: Date;
  direction: FinanceDirection;
  category: FinanceCategory;
  categoryLabel: string;
  kind: FinanceCategoryKind;
  amount: number;
  originalAmount: number | null;
  originalCurrency: string | null;
  description: string;
  reference: string;
  partyName: string;
  accountName: string;
}

export interface ReportAccount {
  id: string;
  name: string;
  type: FinanceAccountType;
  ownerName: string | null;
  opening: number;
  moneyIn: number;
  moneyOut: number;
  closing: number;
}

export interface ReportParty {
  id: string;
  name: string;
  type: FinancePartyType;
  paidTo: number;
  receivedFrom: number;
  owedAtEnd: number;
}

export interface ReportOutstanding {
  partyId: string;
  name: string;
  type: FinancePartyType;
  loanOutstanding: number;
  cardOutstanding: number;
  owed: number;
}

export interface ReportFinancing {
  loanReceived: number;
  investmentReceived: number;
  loanRepaid: number;
  cardRepaid: number;
}

export interface FinanceReport {
  company: ReportCompany;
  window: ReportWindow;
  generatedAt: Date;
  totals: FinanceTotals;
  financing: ReportFinancing;
  incomeByCategory: CategoryTotal[];
  expenseByCategory: CategoryTotal[];
  financingByCategory: CategoryTotal[];
  accounts: ReportAccount[];
  parties: ReportParty[];
  outstanding: ReportOutstanding[];
  transactions: ReportTransaction[];
  transactionCount: number;
}

// ---------------------------------------------------------------------------
// Pure assembly
// ---------------------------------------------------------------------------

export interface AssembleInput {
  company: ReportCompany;
  window: ReportWindow;
  /** Every ledger row with `date <= window.to` (rows before the window feed opening balances). */
  rows: readonly ReportSourceRow[];
  accounts: readonly ReportSourceAccount[];
  parties: readonly ReportSourceParty[];
  now?: Date;
}

function sumAmounts(rows: readonly LedgerRow[]): number {
  return round2(rows.reduce((s, r) => s + (Number.isFinite(r.amount) ? r.amount : 0), 0));
}

export function assembleFinanceReport(input: AssembleInput): FinanceReport {
  const { window } = input;
  const fromMs = window.from.getTime();
  const toMs = window.to.getTime();

  const sorted = [...input.rows].sort((a, b) => a.date.getTime() - b.date.getTime());
  const before = sorted.filter((r) => r.date.getTime() < fromMs);
  const inWindow = sorted.filter(
    (r) => r.date.getTime() >= fromMs && r.date.getTime() <= toMs,
  );
  const upToEnd = sorted.filter((r) => r.date.getTime() <= toMs);

  const totals = summarizeRows(inWindow);
  const byCategory = groupByCategory(inWindow);
  const incomeByCategory = byCategory.filter(
    (c) => c.direction === 'IN' && c.kind === 'OPERATING',
  );
  const expenseByCategory = byCategory.filter(
    (c) => c.direction === 'OUT' && c.kind === 'OPERATING',
  );
  const financingByCategory = byCategory.filter((c) => c.kind === 'FINANCING');

  const catTotal = (cat: FinanceCategory): number =>
    financingByCategory.find((c) => c.category === cat)?.amount ?? 0;
  const financing: ReportFinancing = {
    loanReceived: catTotal('LOAN_RECEIVED'),
    investmentReceived: catTotal('INVESTMENT_RECEIVED'),
    loanRepaid: catTotal('LOAN_REPAYMENT'),
    cardRepaid: catTotal('CARD_REPAYMENT'),
  };

  // Accounts: opening = balance before the window; closing = opening + in − out.
  const accounts: ReportAccount[] = input.accounts
    .map((a) => {
      const beforeRows = before.filter((r) => r.accountId === a.id);
      const windowRows = inWindow.filter((r) => r.accountId === a.id);
      const opening = computeAccountBalance(a.openingBalance, beforeRows);
      const moneyIn = sumAmounts(windowRows.filter((r) => r.direction === 'IN'));
      const moneyOut = sumAmounts(windowRows.filter((r) => r.direction === 'OUT'));
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        ownerName: a.ownerName,
        opening,
        moneyIn,
        moneyOut,
        closing: round2(opening + moneyIn - moneyOut),
      };
    })
    .filter((a) => {
      const src = input.accounts.find((x) => x.id === a.id);
      return (
        (src?.isActive ?? true) ||
        a.moneyIn !== 0 ||
        a.moneyOut !== 0 ||
        a.opening !== 0
      );
    });

  // Parties: activity in the window + balance at the end of the window.
  const parties: ReportParty[] = [];
  const outstanding: ReportOutstanding[] = [];
  for (const p of input.parties) {
    const linked = inWindow.filter((r) => r.partyId === p.id);
    const paidTo = sumAmounts(linked.filter((r) => r.direction === 'OUT'));
    const receivedFrom = sumAmounts(linked.filter((r) => r.direction === 'IN'));
    const balance = computePartyBalance(upToEnd, p.id);
    const touchesWindow =
      linked.length > 0 || inWindow.some((r) => r.accountOwnerPartyId === p.id);
    if (touchesWindow || balance.owed !== 0) {
      parties.push({
        id: p.id,
        name: p.name,
        type: p.type,
        paidTo,
        receivedFrom,
        owedAtEnd: balance.owed,
      });
    }
    if (
      balance.owed !== 0 ||
      balance.loanOutstanding !== 0 ||
      balance.cardOutstanding !== 0
    ) {
      outstanding.push({
        partyId: p.id,
        name: p.name,
        type: p.type,
        loanOutstanding: balance.loanOutstanding,
        cardOutstanding: balance.cardOutstanding,
        owed: balance.owed,
      });
    }
  }
  parties.sort((a, b) => b.paidTo + b.receivedFrom - (a.paidTo + a.receivedFrom));
  outstanding.sort((a, b) => b.owed - a.owed);

  const transactions: ReportTransaction[] = inWindow.map((r) => ({
    id: r.id,
    date: r.date,
    direction: r.direction,
    category: r.category,
    categoryLabel: FINANCE_CATEGORY_META[r.category].label,
    kind: FINANCE_CATEGORY_META[r.category].kind,
    amount: round2(r.amount),
    originalAmount: r.originalAmount,
    originalCurrency: r.originalCurrency,
    description: r.description ?? '',
    reference: r.reference ?? '',
    partyName: r.partyName ?? '',
    accountName: r.accountName ?? '',
  }));

  return {
    company: input.company,
    window,
    generatedAt: input.now ?? new Date(),
    totals,
    financing,
    incomeByCategory,
    expenseByCategory,
    financingByCategory,
    accounts,
    parties,
    outstanding,
    transactions,
    transactionCount: transactions.length,
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const COMPANY_SETTING_KEYS = ['company_name', 'company_address'] as const;

export function companyFromSettings(
  rows: readonly { key: string; value: string }[],
): ReportCompany {
  const get = (k: string) => rows.find((r) => r.key === k)?.value.trim() ?? '';
  return {
    name: get('company_name') || 'OfficePilot',
    address: get('company_address'),
  };
}

export async function buildFinanceReport(
  db: PrismaClient,
  window: ReportWindow,
  now: Date = new Date(),
): Promise<FinanceReport> {
  const [rows, accounts, parties, settings] = await Promise.all([
    db.financeTransaction.findMany({
      where: { date: { lte: window.to } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        date: true,
        direction: true,
        category: true,
        amount: true,
        originalAmount: true,
        originalCurrency: true,
        description: true,
        reference: true,
        partyId: true,
        accountId: true,
        party: { select: { name: true } },
        account: { select: { name: true, ownerPartyId: true } },
      },
    }),
    db.financeAccount.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        openingBalance: true,
        ownerPartyId: true,
        isActive: true,
        ownerParty: { select: { name: true } },
      },
      orderBy: [{ name: 'asc' }],
    }),
    db.financeParty.findMany({
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
    }),
    db.setting.findMany({
      where: { key: { in: [...COMPANY_SETTING_KEYS] } },
      select: { key: true, value: true },
    }),
  ]);

  return assembleFinanceReport({
    company: companyFromSettings(settings),
    window,
    now,
    rows: rows.map((r) => ({
      id: r.id,
      date: r.date,
      direction: r.direction,
      category: r.category,
      amount: r.amount,
      originalAmount: r.originalAmount,
      originalCurrency: r.originalCurrency,
      description: r.description,
      reference: r.reference,
      partyId: r.partyId,
      accountId: r.accountId,
      accountOwnerPartyId: r.account?.ownerPartyId ?? null,
      partyName: r.party?.name ?? null,
      accountName: r.account?.name ?? null,
    })),
    accounts: accounts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      openingBalance: a.openingBalance,
      ownerPartyId: a.ownerPartyId,
      ownerName: a.ownerParty?.name ?? null,
      isActive: a.isActive,
    })),
    parties,
  });
}

/** `praxxel-technologies-finance-2026-08` — filename stem for downloads. */
export function reportFileStem(report: FinanceReport): string {
  const slug = report.company.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${slug || 'officepilot'}-finance-${report.window.fileTag}`;
}
