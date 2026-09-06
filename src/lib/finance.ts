/**
 * Finance module — pure helpers (no I/O).
 *
 * The Finance module is a small cash ledger for the office:
 *
 *   • `FinanceTransaction` rows are money IN or OUT on a given day, tagged
 *     with a `FinanceCategory`, optionally linked to a `FinanceParty` (who
 *     we paid / who paid us) and a `FinanceAccount` (bank / cash / UPI /
 *     someone's credit card that money moved through).
 *   • Categories are either OPERATING (they count towards income and
 *     expense) or FINANCING (loan in / loan repayment / card settlement —
 *     cash moves but it is not profit or loss).
 *   • Party balances answer "kitna dena hai": a FINANCER is owed what they
 *     lent minus what we repaid; a CARD_OWNER is owed what we spent on
 *     their card minus what we settled with them.
 *
 * Everything here is deterministic and unit-tested in `finance.test.ts`.
 * DB-backed loaders live in `src/lib/finance-summary.ts`.
 */

import type {
  FinanceAccountType,
  FinanceCategory,
  FinanceDirection,
  FinancePartyType,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Category metadata
// ---------------------------------------------------------------------------

export type FinanceCategoryKind = 'OPERATING' | 'FINANCING';

export interface FinanceCategoryMeta {
  label: string;
  direction: FinanceDirection;
  kind: FinanceCategoryKind;
  hint: string;
}

/**
 * Single source of truth for category → direction / kind / label. The
 * Prisma enum is flat; this map is what the forms, the summary and the
 * validators consult. Adding a category to the enum without adding it
 * here is a TypeScript error.
 */
export const FINANCE_CATEGORY_META: Record<FinanceCategory, FinanceCategoryMeta> = {
  // ── IN ──────────────────────────────────────────────────────────────
  SALES: {
    label: 'Sales',
    direction: 'IN',
    kind: 'OPERATING',
    hint: 'Product / subscription revenue',
  },
  SERVICE_INCOME: {
    label: 'Service income',
    direction: 'IN',
    kind: 'OPERATING',
    hint: 'Consulting, services, one-off work',
  },
  LOAN_RECEIVED: {
    label: 'Loan received',
    direction: 'IN',
    kind: 'FINANCING',
    hint: 'Money borrowed from a financer — has to be repaid',
  },
  INVESTMENT_RECEIVED: {
    label: 'Investment received',
    direction: 'IN',
    kind: 'FINANCING',
    hint: 'Capital put in by founders / investors',
  },
  REFUND_RECEIVED: {
    label: 'Refund received',
    direction: 'IN',
    kind: 'OPERATING',
    hint: 'Money that came back (reversed payout, vendor refund)',
  },
  OTHER_INCOME: {
    label: 'Other income',
    direction: 'IN',
    kind: 'OPERATING',
    hint: 'Anything else that came in',
  },
  // ── OUT ─────────────────────────────────────────────────────────────
  ADS: {
    label: 'Ads',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Facebook / Google / influencer spend',
  },
  SOFTWARE: {
    label: 'Software / hosting',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'SaaS, cloud, domains, APIs',
  },
  PAYOUT: {
    label: 'Host / worker payout',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Withdrawals paid to hosts and contract workers',
  },
  SALARY: {
    label: 'Salary',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Monthly salaries to employees',
  },
  PROFESSIONAL_FEES: {
    label: 'Professional fees',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'CA, legal, consultants',
  },
  LOAN_REPAYMENT: {
    label: 'Loan repayment',
    direction: 'OUT',
    kind: 'FINANCING',
    hint: 'Paying a financer back',
  },
  CARD_REPAYMENT: {
    label: 'Card repayment',
    direction: 'OUT',
    kind: 'FINANCING',
    hint: 'Settling a card owner for spend made on their card',
  },
  RENT: {
    label: 'Rent',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Office rent',
  },
  UTILITIES: {
    label: 'Utilities',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Electricity, internet, phone',
  },
  OFFICE: {
    label: 'Office & supplies',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Stationery, equipment, snacks',
  },
  TRAVEL: {
    label: 'Travel',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Cabs, tickets, fuel',
  },
  TAX: {
    label: 'Tax & government',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'GST, TDS, filing fees',
  },
  BANK_CHARGES: {
    label: 'Bank / gateway charges',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Bank fees, payment-gateway commission',
  },
  OTHER_EXPENSE: {
    label: 'Other expense',
    direction: 'OUT',
    kind: 'OPERATING',
    hint: 'Anything else that went out',
  },
};

/** Every category, in the order they should appear in dropdowns. */
export const ALL_FINANCE_CATEGORIES = Object.keys(
  FINANCE_CATEGORY_META,
) as FinanceCategory[];

/** Categories valid for one direction, in dropdown order. */
export function categoriesForDirection(
  direction: FinanceDirection,
): FinanceCategory[] {
  return ALL_FINANCE_CATEGORIES.filter(
    (c) => FINANCE_CATEGORY_META[c].direction === direction,
  );
}

export function categoryDirection(category: FinanceCategory): FinanceDirection {
  return FINANCE_CATEGORY_META[category].direction;
}

export function categoryLabel(category: FinanceCategory): string {
  return FINANCE_CATEGORY_META[category].label;
}

/** `true` when the category counts towards income / expense (P&L). */
export function isOperatingCategory(category: FinanceCategory): boolean {
  return FINANCE_CATEGORY_META[category].kind === 'OPERATING';
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export const FINANCE_DIRECTION_LABELS: Record<FinanceDirection, string> = {
  IN: 'Money in',
  OUT: 'Money out',
};

export const FINANCE_PARTY_TYPE_LABELS: Record<FinancePartyType, string> = {
  FINANCER: 'Financer (gives loans)',
  CARD_OWNER: 'Card owner (lends credit card)',
  WORKER: 'Host / worker (withdraws)',
  VENDOR: 'Vendor (we pay them)',
  CLIENT: 'Client (pays us)',
  EMPLOYEE: 'Employee (salary / stipend, linked to the panel)',
  INTERMEDIARY: 'Intermediary (money passes through them)',
  OTHER: 'Other',
};

/** Short party-type labels for badges / tables. */
export const FINANCE_PARTY_TYPE_SHORT: Record<FinancePartyType, string> = {
  FINANCER: 'Financer',
  CARD_OWNER: 'Card owner',
  WORKER: 'Worker',
  VENDOR: 'Vendor',
  CLIENT: 'Client',
  EMPLOYEE: 'Employee',
  INTERMEDIARY: 'Intermediary',
  OTHER: 'Other',
};

export const FINANCE_ACCOUNT_TYPE_LABELS: Record<FinanceAccountType, string> = {
  BANK: 'Bank account',
  CASH: 'Cash',
  UPI: 'UPI',
  CREDIT_CARD: 'Credit card',
  WALLET: 'Wallet',
  OTHER: 'Other',
};

export const ALL_FINANCE_PARTY_TYPES = Object.keys(
  FINANCE_PARTY_TYPE_LABELS,
) as FinancePartyType[];

export const ALL_FINANCE_ACCOUNT_TYPES = Object.keys(
  FINANCE_ACCOUNT_TYPE_LABELS,
) as FinanceAccountType[];

// ---------------------------------------------------------------------------
// Money formatting
// ---------------------------------------------------------------------------

/**
 * `₹1,23,456` — Indian grouping, no trailing `.00`, up to 2 decimals.
 * Non-finite input renders as `₹0` so a bad row never crashes a page.
 */
export function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '₹0';
  }
  const abs = Math.abs(value);
  const formatted = new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(abs);
  return value < 0 ? `-₹${formatted}` : `₹${formatted}`;
}

/** Round to 2 decimals — keeps float drift out of totals. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// Dates — the ledger works in UTC calendar days
// ---------------------------------------------------------------------------

const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `'2026-08'` for the UTC month the date falls in. */
export function toMonthKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** `'2026-08-07'` for the UTC calendar day. */
export function toDateKey(date: Date): string {
  return `${toMonthKey(date)}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/**
 * Parse `'YYYY-MM-DD'` into a UTC-midnight `Date`. Returns `null` for
 * malformed input or impossible dates (2026-02-31).
 */
export function parseDateOnly(input: string): Date | null {
  const m = DATE_ONLY_RE.exec(input.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  ) {
    return null;
  }
  return date;
}

/**
 * Inclusive UTC range for a `'YYYY-MM'` key: first ms of the month to the
 * last ms of the month. `null` for malformed keys.
 */
export function monthRange(monthKey: string): { from: Date; to: Date } | null {
  const m = MONTH_KEY_RE.exec(monthKey.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) return null;
  const from = new Date(Date.UTC(y, mo - 1, 1, 0, 0, 0, 0));
  const to = new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999));
  return { from, to };
}

/** `shiftMonthKey('2026-01', -1) === '2025-12'`. */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const m = MONTH_KEY_RE.exec(monthKey.trim());
  if (!m) return monthKey;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1 + delta, 1));
  return toMonthKey(date);
}

/** `'August 2026'` for display. */
export function monthLabel(monthKey: string): string {
  const range = monthRange(monthKey);
  if (!range) return monthKey;
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(range.from);
}

/** `'07 Aug 2026'` — formats the UTC calendar day regardless of host TZ. */
export function formatDateUtc(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

// ---------------------------------------------------------------------------
// Ledger maths
// ---------------------------------------------------------------------------

/**
 * Minimal row shape the maths needs. `accountOwnerPartyId` is the owner
 * of the account the money moved through (set for lent credit cards).
 */
export interface LedgerRow {
  direction: FinanceDirection;
  category: FinanceCategory;
  amount: number;
  partyId?: string | null;
  /** Intermediary the bank paid when the money was routed; no balance effect. */
  viaPartyId?: string | null;
  accountId?: string | null;
  accountOwnerPartyId?: string | null;
}

export interface PassThrough {
  /** Money that went out through this party on its way to someone else. */
  routedOut: number;
  /** Money that came in through this party from someone else. */
  routedIn: number;
  count: number;
}

/**
 * How much money merely passed through a party (rows where they are the
 * `viaPartyId`). Purely informational — balances ignore it.
 */
export function computePassThrough(
  rows: readonly LedgerRow[],
  partyId: string,
): PassThrough {
  let routedOut = 0;
  let routedIn = 0;
  let count = 0;
  for (const row of rows) {
    if (row.viaPartyId !== partyId) continue;
    const amount = Number.isFinite(row.amount) ? row.amount : 0;
    count += 1;
    if (row.direction === 'OUT') routedOut += amount;
    else routedIn += amount;
  }
  return { routedOut: round2(routedOut), routedIn: round2(routedIn), count };
}

export interface FinanceTotals {
  /** Every IN row, including loans / investment. */
  cashIn: number;
  /** Every OUT row, including loan / card repayments. */
  cashOut: number;
  /** IN rows with an OPERATING category. */
  income: number;
  /** OUT rows with an OPERATING category. */
  expense: number;
  /** `income - expense`. */
  net: number;
}

export function summarizeRows(rows: readonly LedgerRow[]): FinanceTotals {
  let cashIn = 0;
  let cashOut = 0;
  let income = 0;
  let expense = 0;
  for (const row of rows) {
    const amount = Number.isFinite(row.amount) ? row.amount : 0;
    const operating = isOperatingCategory(row.category);
    if (row.direction === 'IN') {
      cashIn += amount;
      if (operating) income += amount;
    } else {
      cashOut += amount;
      if (operating) expense += amount;
    }
  }
  return {
    cashIn: round2(cashIn),
    cashOut: round2(cashOut),
    income: round2(income),
    expense: round2(expense),
    net: round2(income - expense),
  };
}

export interface CategoryTotal {
  category: FinanceCategory;
  label: string;
  direction: FinanceDirection;
  kind: FinanceCategoryKind;
  amount: number;
  count: number;
}

/** Totals per category, largest first. Optionally limited to one direction. */
export function groupByCategory(
  rows: readonly LedgerRow[],
  direction?: FinanceDirection,
): CategoryTotal[] {
  const acc = new Map<FinanceCategory, { amount: number; count: number }>();
  for (const row of rows) {
    if (direction !== undefined && row.direction !== direction) continue;
    const bucket = acc.get(row.category) ?? { amount: 0, count: 0 };
    bucket.amount += Number.isFinite(row.amount) ? row.amount : 0;
    bucket.count += 1;
    acc.set(row.category, bucket);
  }
  return [...acc.entries()]
    .map(([category, v]) => ({
      category,
      label: FINANCE_CATEGORY_META[category].label,
      direction: FINANCE_CATEGORY_META[category].direction,
      kind: FINANCE_CATEGORY_META[category].kind,
      amount: round2(v.amount),
      count: v.count,
    }))
    .sort((a, b) => b.amount - a.amount || a.label.localeCompare(b.label));
}

export interface PartyBalance {
  /** LOAN_RECEIVED rows linked to the party. */
  loanReceived: number;
  /** LOAN_REPAYMENT rows linked to the party. */
  loanRepaid: number;
  /** `loanReceived - loanRepaid`. */
  loanOutstanding: number;
  /** Net spend through accounts the party owns (OUT minus IN on their card). */
  cardSpend: number;
  /** CARD_REPAYMENT rows linked to the party. */
  cardRepaid: number;
  /** `cardSpend - cardRepaid`. */
  cardOutstanding: number;
  /** Every OUT row linked to the party, any category. */
  paidTo: number;
  /** Every IN row linked to the party, any category. */
  receivedFrom: number;
  /** What we still owe them: `loanOutstanding + cardOutstanding`. */
  owed: number;
}

/**
 * How much we owe (or have settled with) one party, from the full ledger.
 *
 *   owed = (loans they gave − loans we repaid)
 *        + (spend on their accounts − card repayments to them)
 */
export function computePartyBalance(
  rows: readonly LedgerRow[],
  partyId: string,
): PartyBalance {
  let loanReceived = 0;
  let loanRepaid = 0;
  let cardSpend = 0;
  let cardRepaid = 0;
  let paidTo = 0;
  let receivedFrom = 0;

  for (const row of rows) {
    const amount = Number.isFinite(row.amount) ? row.amount : 0;
    const linked = row.partyId === partyId;
    const viaTheirAccount = row.accountOwnerPartyId === partyId;

    if (linked) {
      if (row.direction === 'IN') {
        receivedFrom += amount;
        if (row.category === 'LOAN_RECEIVED') loanReceived += amount;
      } else {
        paidTo += amount;
        if (row.category === 'LOAN_REPAYMENT') loanRepaid += amount;
        if (row.category === 'CARD_REPAYMENT') cardRepaid += amount;
      }
    }

    if (viaTheirAccount) {
      if (row.direction === 'OUT') cardSpend += amount;
      else cardSpend -= amount;
    }
  }

  const loanOutstanding = round2(loanReceived - loanRepaid);
  const cardOutstanding = round2(cardSpend - cardRepaid);
  return {
    loanReceived: round2(loanReceived),
    loanRepaid: round2(loanRepaid),
    loanOutstanding,
    cardSpend: round2(cardSpend),
    cardRepaid: round2(cardRepaid),
    cardOutstanding,
    paidTo: round2(paidTo),
    receivedFrom: round2(receivedFrom),
    owed: round2(loanOutstanding + cardOutstanding),
  };
}

/** `opening + ΣIN − ΣOUT` for one account's rows. */
export function computeAccountBalance(
  openingBalance: number,
  rows: readonly Pick<LedgerRow, 'direction' | 'amount'>[],
): number {
  let balance = Number.isFinite(openingBalance) ? openingBalance : 0;
  for (const row of rows) {
    const amount = Number.isFinite(row.amount) ? row.amount : 0;
    balance += row.direction === 'IN' ? amount : -amount;
  }
  return round2(balance);
}
