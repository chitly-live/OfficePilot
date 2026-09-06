/**
 * Finance module — Prisma-backed loaders.
 *
 * Shared by `GET /api/finance/summary`, the `/finance` overview page and
 * the party detail page so every surface computes balances the same way.
 * All maths is delegated to the pure helpers in `src/lib/finance.ts`.
 *
 * Scale note: the office ledger is a few hundred rows a month, so the
 * loaders pull the rows they need and aggregate in memory rather than
 * juggling `groupBy` per metric. Revisit if this ever grows past
 * ~50k rows.
 */

import type {
  FinanceAccountType,
  FinanceCategory,
  FinanceDirection,
  FinancePartyType,
  Prisma,
  PrismaClient,
} from '@prisma/client';

import { productWhere, type ProductScope } from '@/lib/products';
import {
  FINANCE_CATEGORY_META,
  computeAccountBalance,
  computePartyBalance,
  groupByCategory,
  monthLabel,
  monthRange,
  round2,
  shiftMonthKey,
  summarizeRows,
  toMonthKey,
  type CategoryTotal,
  type FinanceTotals,
  type LedgerRow,
  type PartyBalance,
} from '@/lib/finance';

export type FinanceDbClient = PrismaClient | Prisma.TransactionClient;

/** How many trailing months the overview trend chart shows. */
const TREND_MONTHS = 6;
/** Rows on the overview "recent" list. */
const RECENT_LIMIT = 8;
/** Parties on the overview "top payees" list. */
const TOP_PARTIES_LIMIT = 8;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FinancePartyTotal {
  partyId: string;
  name: string;
  type: FinancePartyType;
  paidTo: number;
  receivedFrom: number;
}

export interface FinanceAccountTotal {
  accountId: string;
  name: string;
  type: FinanceAccountType;
  ownerName: string | null;
  cashIn: number;
  cashOut: number;
  /** All-time balance: opening + ΣIN − ΣOUT. */
  balance: number;
}

export interface FinanceOutstanding {
  partyId: string;
  name: string;
  type: FinancePartyType;
  owed: number;
  loanOutstanding: number;
  cardOutstanding: number;
}

export interface FinanceMonthPoint {
  month: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

export interface FinanceRecentRow {
  id: string;
  date: Date;
  direction: FinanceDirection;
  category: FinanceCategory;
  amount: number;
  description: string | null;
  partyName: string | null;
  accountName: string | null;
}

export interface FinanceSummary {
  from: Date;
  to: Date;
  totals: FinanceTotals;
  byCategory: CategoryTotal[];
  expenseByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  topParties: FinancePartyTotal[];
  accounts: FinanceAccountTotal[];
  outstanding: FinanceOutstanding[];
  monthly: FinanceMonthPoint[];
  recent: FinanceRecentRow[];
  transactionCount: number;
  /** Operating income / expense per product in the window (`productId`
   *  null = company-level). Only meaningful when no product filter is
   *  applied; empty otherwise. */
  byProduct: FinanceProductTotal[];
}

export interface FinanceProductTotal {
  /** `null` = company-level rows. */
  productId: string | null;
  name: string;
  color: string | null;
  income: number;
  expense: number;
  net: number;
  count: number;
}

// ---------------------------------------------------------------------------
// Internal row shape
// ---------------------------------------------------------------------------

interface DbRow extends LedgerRow {
  id: string;
  date: Date;
  description: string | null;
  partyId: string | null;
  accountId: string | null;
  accountOwnerPartyId: string | null;
  productId: string | null;
}

const ROW_SELECT = {
  id: true,
  date: true,
  direction: true,
  category: true,
  amount: true,
  description: true,
  partyId: true,
  accountId: true,
  productId: true,
  account: { select: { ownerPartyId: true } },
} as const;

type RawRow = {
  id: string;
  date: Date;
  direction: FinanceDirection;
  category: FinanceCategory;
  amount: number;
  description: string | null;
  partyId: string | null;
  accountId: string | null;
  productId: string | null;
  account: { ownerPartyId: string | null } | null;
};

function toDbRow(row: RawRow): DbRow {
  return {
    id: row.id,
    date: row.date,
    direction: row.direction,
    category: row.category,
    amount: row.amount,
    description: row.description,
    partyId: row.partyId,
    accountId: row.accountId,
    accountOwnerPartyId: row.account?.ownerPartyId ?? null,
    productId: row.productId,
  };
}

async function loadAllRows(
  db: FinanceDbClient,
  scope: ProductScope = { kind: 'all' },
): Promise<DbRow[]> {
  const rows = await db.financeTransaction.findMany({
    where: productWhere(scope),
    select: ROW_SELECT,
    orderBy: [{ date: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toDbRow);
}

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

/**
 * Balance for every party from the full ledger. Used by the parties
 * list so "kitna dena hai" is visible without opening each party.
 */
export async function loadPartyBalances(
  db: FinanceDbClient,
  partyIds?: readonly string[],
  scope: ProductScope = { kind: 'all' },
): Promise<Map<string, PartyBalance>> {
  const rows = await loadAllRows(db, scope);
  const ids =
    partyIds ??
    Array.from(
      new Set(
        rows.flatMap((r) =>
          [r.partyId, r.accountOwnerPartyId].filter(
            (v): v is string => v !== null,
          ),
        ),
      ),
    );
  const out = new Map<string, PartyBalance>();
  for (const id of ids) {
    out.set(id, computePartyBalance(rows, id));
  }
  return out;
}

/** Balance for a single party. */
export async function loadPartyBalance(
  db: FinanceDbClient,
  partyId: string,
  scope: ProductScope = { kind: 'all' },
): Promise<PartyBalance> {
  const rows = await loadAllRows(db, scope);
  return computePartyBalance(rows, partyId);
}

/**
 * All-time balance per account (`opening + ΣIN − ΣOUT`). Used by the
 * accounts page.
 */
export async function loadAccountBalances(
  db: FinanceDbClient,
): Promise<Map<string, number>> {
  const [accounts, rows] = await Promise.all([
    db.financeAccount.findMany({
      select: { id: true, openingBalance: true },
    }),
    db.financeTransaction.findMany({
      select: { accountId: true, direction: true, amount: true },
      where: { accountId: { not: null } },
    }),
  ]);
  const byAccount = new Map<string, { direction: FinanceDirection; amount: number }[]>();
  for (const row of rows) {
    if (!row.accountId) continue;
    const bucket = byAccount.get(row.accountId) ?? [];
    bucket.push({ direction: row.direction, amount: row.amount });
    byAccount.set(row.accountId, bucket);
  }
  const out = new Map<string, number>();
  for (const account of accounts) {
    out.set(
      account.id,
      computeAccountBalance(account.openingBalance, byAccount.get(account.id) ?? []),
    );
  }
  return out;
}

/**
 * Everything the overview page / summary API needs for one date window.
 * Outstanding balances and account balances are all-time (a loan taken
 * in March is still owed in August); totals, category breakdowns and top
 * parties are scoped to `[from, to]`.
 */
export async function loadFinanceSummary(
  db: FinanceDbClient,
  window: { from: Date; to: Date },
  opts: {
    /** Header scope: filter every figure to one product / company-level. */
    scope?: ProductScope;
    /** Label used for the company-level bucket in `byProduct`. */
    companyLabel?: string;
  } = {},
): Promise<FinanceSummary> {
  const { from, to } = window;
  const scope: ProductScope = opts.scope ?? { kind: 'all' };

  const [everyRow, parties, accounts, products] = await Promise.all([
    loadAllRows(db),
    db.financeParty.findMany({
      select: { id: true, name: true, type: true },
    }),
    db.financeAccount.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        openingBalance: true,
        ownerParty: { select: { name: true } },
      },
    }),
    db.product.findMany({ select: { id: true, name: true, color: true, sortOrder: true } }),
  ]);

  const partyById = new Map(parties.map((p) => [p.id, p]));

  const allRows =
    scope.kind === 'all'
      ? everyRow
      : everyRow.filter((r) =>
          scope.kind === 'company' ? r.productId === null : r.productId === scope.product.id,
        );

  const inWindow = allRows.filter(
    (r) => r.date.getTime() >= from.getTime() && r.date.getTime() <= to.getTime(),
  );

  // -- Totals + category breakdowns (window) ---------------------------------
  const totals = summarizeRows(inWindow);
  const byCategory = groupByCategory(inWindow);
  const expenseByCategory = byCategory.filter(
    (c) => c.direction === 'OUT' && c.kind === 'OPERATING',
  );
  const incomeByCategory = byCategory.filter(
    (c) => c.direction === 'IN' && c.kind === 'OPERATING',
  );

  // -- Top parties (window) ---------------------------------------------------
  const partyAcc = new Map<string, { paidTo: number; receivedFrom: number }>();
  for (const row of inWindow) {
    if (!row.partyId) continue;
    const bucket = partyAcc.get(row.partyId) ?? { paidTo: 0, receivedFrom: 0 };
    if (row.direction === 'OUT') bucket.paidTo += row.amount;
    else bucket.receivedFrom += row.amount;
    partyAcc.set(row.partyId, bucket);
  }
  const topParties: FinancePartyTotal[] = [...partyAcc.entries()]
    .map(([partyId, v]) => {
      const party = partyById.get(partyId);
      return {
        partyId,
        name: party?.name ?? 'Unknown party',
        type: party?.type ?? 'OTHER',
        paidTo: Math.round(v.paidTo * 100) / 100,
        receivedFrom: Math.round(v.receivedFrom * 100) / 100,
      };
    })
    .sort((a, b) => b.paidTo + b.receivedFrom - (a.paidTo + a.receivedFrom))
    .slice(0, TOP_PARTIES_LIMIT);

  // -- Accounts (window flow + all-time balance) ------------------------------
  const accountFlow = new Map<string, { cashIn: number; cashOut: number }>();
  for (const row of inWindow) {
    if (!row.accountId) continue;
    const bucket = accountFlow.get(row.accountId) ?? { cashIn: 0, cashOut: 0 };
    if (row.direction === 'IN') bucket.cashIn += row.amount;
    else bucket.cashOut += row.amount;
    accountFlow.set(row.accountId, bucket);
  }
  const accountTotals: FinanceAccountTotal[] = accounts.map((account) => {
    const flow = accountFlow.get(account.id) ?? { cashIn: 0, cashOut: 0 };
    const allTime = allRows.filter((r) => r.accountId === account.id);
    return {
      accountId: account.id,
      name: account.name,
      type: account.type,
      ownerName: account.ownerParty?.name ?? null,
      cashIn: Math.round(flow.cashIn * 100) / 100,
      cashOut: Math.round(flow.cashOut * 100) / 100,
      balance: computeAccountBalance(account.openingBalance, allTime),
    };
  });

  // -- Outstanding (all-time) ---------------------------------------------------
  const outstanding: FinanceOutstanding[] = [];
  for (const party of parties) {
    const balance = computePartyBalance(allRows, party.id);
    if (balance.owed === 0 && balance.loanOutstanding === 0 && balance.cardOutstanding === 0) {
      continue;
    }
    outstanding.push({
      partyId: party.id,
      name: party.name,
      type: party.type,
      owed: balance.owed,
      loanOutstanding: balance.loanOutstanding,
      cardOutstanding: balance.cardOutstanding,
    });
  }
  outstanding.sort((a, b) => b.owed - a.owed);

  // -- Monthly trend (last N months ending at the window's end month) ---------
  const endKey = toMonthKey(to);
  const monthly: FinanceMonthPoint[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i -= 1) {
    const key = shiftMonthKey(endKey, -i);
    const range = monthRange(key);
    if (!range) continue;
    const rows = allRows.filter(
      (r) =>
        r.date.getTime() >= range.from.getTime() &&
        r.date.getTime() <= range.to.getTime(),
    );
    const t = summarizeRows(rows);
    monthly.push({
      month: key,
      label: monthLabel(key),
      income: t.income,
      expense: t.expense,
      net: t.net,
    });
  }

  // -- Recent rows (window, newest first) ---------------------------------------
  const accountById = new Map(accounts.map((a) => [a.id, a]));
  const recent: FinanceRecentRow[] = [...inWindow]
    .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id.localeCompare(a.id))
    .slice(0, RECENT_LIMIT)
    .map((row) => ({
      id: row.id,
      date: row.date,
      direction: row.direction,
      category: row.category,
      amount: row.amount,
      description: row.description,
      partyName: row.partyId ? (partyById.get(row.partyId)?.name ?? null) : null,
      accountName: row.accountId
        ? (accountById.get(row.accountId)?.name ?? null)
        : null,
    }));

  // -- Per-product split (window, only when unscoped) -------------------------
  const byProduct: FinanceProductTotal[] = [];
  if (scope.kind === 'all') {
    const acc = new Map<string | null, FinanceProductTotal>();
    const sorted = [...products].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const pr of sorted) {
      acc.set(pr.id, { productId: pr.id, name: pr.name, color: pr.color, income: 0, expense: 0, net: 0, count: 0 });
    }
    acc.set(null, {
      productId: null,
      name: opts.companyLabel ?? 'Company-level',
      color: null,
      income: 0,
      expense: 0,
      net: 0,
      count: 0,
    });
    for (const row of inWindow) {
      const key = row.productId && acc.has(row.productId) ? row.productId : null;
      const bucket = acc.get(key)!;
      bucket.count += 1;
      if (FINANCE_CATEGORY_META[row.category].kind !== 'OPERATING') continue;
      if (row.direction === 'IN') bucket.income += row.amount;
      else bucket.expense += row.amount;
    }
    for (const bucket of acc.values()) {
      bucket.net = round2(bucket.income - bucket.expense);
      bucket.income = round2(bucket.income);
      bucket.expense = round2(bucket.expense);
      if (bucket.count > 0 || bucket.productId !== null) byProduct.push(bucket);
    }
  }

  return {
    from,
    to,
    totals,
    byCategory,
    expenseByCategory,
    incomeByCategory,
    topParties,
    accounts: accountTotals,
    outstanding,
    monthly,
    recent,
    transactionCount: inWindow.length,
    byProduct,
  };
}
