/**
 * Zod schemas + DTO types for the Finance module.
 *
 *   • POST   /api/finance/transactions        → `financeTransactionCreateSchema`
 *   • PATCH  /api/finance/transactions/[id]   → `financeTransactionUpdateSchema`
 *   • GET    /api/finance/transactions        → `financeTransactionListQuerySchema`
 *   • POST   /api/finance/parties             → `financePartyCreateSchema`
 *   • PATCH  /api/finance/parties/[id]        → `financePartyUpdateSchema`
 *   • GET    /api/finance/parties             → `financePartyListQuerySchema`
 *   • POST   /api/finance/accounts            → `financeAccountCreateSchema`
 *   • PATCH  /api/finance/accounts/[id]       → `financeAccountUpdateSchema`
 *   • GET    /api/finance/accounts            → `financeAccountListQuerySchema`
 *   • GET    /api/finance/summary             → `financeSummaryQuerySchema`
 *
 * Dates: the ledger works in UTC calendar days. Date fields accept either
 * `'YYYY-MM-DD'` (normalised to UTC midnight) or a full ISO datetime.
 */

import { z } from 'zod';
import {
  FinanceAccountType,
  FinanceCategory,
  FinanceDirection,
  FinancePartyType,
} from '@prisma/client';

import { categoryDirection, parseDateOnly } from '@/lib/finance';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 254;
const MAX_NOTES_LENGTH = 2000;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_REFERENCE_LENGTH = 100;
const MAX_SEARCH_LENGTH = 200;
/** ₹100 cr — anything above is a typo. */
const MAX_AMOUNT = 1_000_000_000;

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `2026-08-07T10:15:00Z`, `2026-08-07T10:15:00.000+05:30`, … */
const ISO_DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

// ---------------------------------------------------------------------------
// Reusable fields
// ---------------------------------------------------------------------------

const idField = z.string().trim().min(1, 'ID is required').max(64);

const nameField = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(MAX_NAME_LENGTH, `Name must be ${MAX_NAME_LENGTH} characters or fewer`);

const phoneField = z
  .string()
  .trim()
  .max(MAX_PHONE_LENGTH, `Phone must be ${MAX_PHONE_LENGTH} characters or fewer`)
  .regex(phoneRegex, 'Invalid phone number');

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email('Invalid email address')
  .max(MAX_EMAIL_LENGTH);

const notesField = z
  .string()
  .trim()
  .max(MAX_NOTES_LENGTH, `Notes must be ${MAX_NOTES_LENGTH} characters or fewer`);

const descriptionField = z
  .string()
  .trim()
  .max(
    MAX_DESCRIPTION_LENGTH,
    `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`,
  );

const referenceField = z
  .string()
  .trim()
  .max(
    MAX_REFERENCE_LENGTH,
    `Reference must be ${MAX_REFERENCE_LENGTH} characters or fewer`,
  );

/** Positive INR amount. */
const amountField = z
  .number()
  .finite('Amount must be a number')
  .positive('Amount must be greater than zero')
  .max(MAX_AMOUNT, `Amount must be ${MAX_AMOUNT} or less`);

/** Signed INR amount (opening balances may be negative for a card). */
const signedAmountField = z
  .number()
  .finite('Amount must be a number')
  .min(-MAX_AMOUNT)
  .max(MAX_AMOUNT);

/** ISO-4217 code, upper-cased. */
const currencyField = z
  .string()
  .trim()
  .regex(/^[A-Za-z]{3}$/u, 'Currency must be a 3-letter code')
  .transform((s) => s.toUpperCase());

/**
 * `'YYYY-MM-DD'` → UTC midnight; full ISO datetimes pass through. Invalid
 * strings (and impossible dates) are rejected by the trailing check.
 */
const dateField = z
  .union([z.string(), z.date()])
  .transform((val, ctx) => {
    if (val instanceof Date) {
      if (Number.isNaN(val.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
        return z.NEVER;
      }
      return val;
    }
    const s = val.trim();
    if (DATE_ONLY_RE.test(s)) {
      const parsed = parseDateOnly(s);
      if (!parsed) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
        return z.NEVER;
      }
      return parsed;
    }
    if (ISO_DATETIME_RE.test(s)) {
      const parsed = new Date(s);
      if (Number.isNaN(parsed.getTime())) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
        return z.NEVER;
      }
      return parsed;
    }
    // Anything else (07/08/2026, "Aug 7", epoch numbers as strings…) is
    // ambiguous between DD/MM and MM/DD — refuse rather than guess.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Date must be YYYY-MM-DD',
    });
    return z.NEVER;
  });

const monthKeyField = z
  .string()
  .trim()
  .regex(MONTH_KEY_RE, 'Month must look like YYYY-MM');

const directionField = z.nativeEnum(FinanceDirection);
const categoryField = z.nativeEnum(FinanceCategory);
const partyTypeField = z.nativeEnum(FinancePartyType);
const accountTypeField = z.nativeEnum(FinanceAccountType);

const pageField = z.coerce
  .number()
  .int('Page must be an integer')
  .positive('Page must be positive')
  .default(DEFAULT_PAGE);

const pageSizeField = z.coerce
  .number()
  .int('Page size must be an integer')
  .positive('Page size must be positive')
  .max(MAX_PAGE_SIZE, `Page size cannot exceed ${MAX_PAGE_SIZE}`)
  .default(DEFAULT_PAGE_SIZE);

const boolFromQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((val) => (typeof val === 'boolean' ? val : val === 'true'));

/**
 * Comma-separated multi-value query parser — same helper the other
 * modules use (`?category=ADS,SOFTWARE`).
 */
function multiEnum<T extends [string, ...string[]]>(values: T) {
  const single = z.enum(values);
  const multi = z.array(single).min(1);
  return z
    .union([single, multi, z.string()])
    .transform((val, ctx): z.infer<typeof single>[] => {
      if (Array.isArray(val)) return val;
      const parts = String(val)
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean);
      const out: z.infer<typeof single>[] = [];
      for (const part of parts) {
        const parsed = single.safeParse(part);
        if (!parsed.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid value: ${part}`,
          });
          return z.NEVER;
        }
        out.push(parsed.data);
      }
      if (out.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'At least one value is required',
        });
        return z.NEVER;
      }
      return out;
    });
}

const categoryValues = Object.values(FinanceCategory) as [
  FinanceCategory,
  ...FinanceCategory[],
];
const partyTypeValues = Object.values(FinancePartyType) as [
  FinancePartyType,
  ...FinancePartyType[],
];
const accountTypeValues = Object.values(FinanceAccountType) as [
  FinanceAccountType,
  ...FinanceAccountType[],
];

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

const transactionBase = {
  date: dateField,
  direction: directionField,
  category: categoryField,
  amount: amountField,
  originalAmount: amountField.optional(),
  originalCurrency: currencyField.optional(),
  description: descriptionField.optional(),
  reference: referenceField.optional(),
  dueDate: dateField.optional(),
  partyId: idField.optional(),
  /** Intermediary the bank actually paid (money routed through them). */
  viaPartyId: idField.optional(),
  accountId: idField.optional(),
  /** CARD_REPAYMENT only: which credit card's bill this payment settles. */
  settlesAccountId: idField.optional(),
};

/**
 * Body for `POST /api/finance/transactions`.
 *
 *   • `category` must belong to `direction` (an ADS row can't be IN).
 *   • `originalAmount` / `originalCurrency` come together or not at all.
 */
export const financeTransactionCreateSchema = z
  .object(transactionBase)
  .refine((v) => categoryDirection(v.category) === v.direction, {
    message: 'Category does not match the direction',
    path: ['category'],
  })
  .refine(
    (v) =>
      (v.originalAmount === undefined) === (v.originalCurrency === undefined),
    {
      message: 'Original amount and currency must be given together',
      path: ['originalAmount'],
    },
  )
  .refine((v) => !v.viaPartyId || v.viaPartyId !== v.partyId, {
    message: 'Routed-via party must be different from the party',
    path: ['viaPartyId'],
  });

export type FinanceTransactionCreateInput = z.infer<
  typeof financeTransactionCreateSchema
>;

/**
 * Body for `PATCH /api/finance/transactions/[id]`. Every field optional;
 * nullable ones can be cleared. Direction/category consistency is
 * re-checked by the route against the merged row.
 */
export const financeTransactionUpdateSchema = z
  .object({
    date: dateField.optional(),
    direction: directionField.optional(),
    category: categoryField.optional(),
    amount: amountField.optional(),
    originalAmount: amountField.nullable().optional(),
    originalCurrency: currencyField.nullable().optional(),
    description: descriptionField.nullable().optional(),
    reference: referenceField.nullable().optional(),
    dueDate: dateField.nullable().optional(),
    partyId: idField.nullable().optional(),
    viaPartyId: idField.nullable().optional(),
    accountId: idField.nullable().optional(),
    settlesAccountId: idField.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  })
  .refine(
    (value) =>
      !value.viaPartyId || !value.partyId || value.viaPartyId !== value.partyId,
    {
      message: 'Routed-via party must be different from the party',
      path: ['viaPartyId'],
    },
  );

export type FinanceTransactionUpdateInput = z.infer<
  typeof financeTransactionUpdateSchema
>;

export const FINANCE_TRANSACTION_SORT_KEYS = ['date', 'amount', 'created'] as const;
export type FinanceTransactionSortKey =
  (typeof FINANCE_TRANSACTION_SORT_KEYS)[number];

/**
 * Query string for `GET /api/finance/transactions`. `month` is a shortcut
 * for a `dateFrom`/`dateTo` pair covering one UTC month; explicit
 * `dateFrom`/`dateTo` win when both are present.
 */
export const financeTransactionListQuerySchema = z
  .object({
    direction: directionField.optional(),
    category: multiEnum(categoryValues).optional(),
    partyId: idField.optional(),
    accountId: idField.optional(),
    month: monthKeyField.optional(),
    dateFrom: dateField.optional(),
    dateTo: dateField.optional(),
    search: z
      .string()
      .trim()
      .min(1, 'Search query cannot be empty')
      .max(MAX_SEARCH_LENGTH)
      .optional(),
    page: pageField,
    pageSize: pageSizeField,
    sortBy: z.enum(FINANCE_TRANSACTION_SORT_KEYS).default('date'),
    sortDir: z.enum(['asc', 'desc']).default('desc'),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type FinanceTransactionListQuery = z.infer<
  typeof financeTransactionListQuerySchema
>;

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

export const financePartyCreateSchema = z.object({
  name: nameField,
  type: partyTypeField.default(FinancePartyType.OTHER),
  phone: phoneField.optional(),
  email: emailField.optional(),
  notes: notesField.optional(),
  isActive: z.boolean().optional().default(true),
});

export type FinancePartyCreateInput = z.infer<typeof financePartyCreateSchema>;

export const financePartyUpdateSchema = z
  .object({
    name: nameField.optional(),
    type: partyTypeField.optional(),
    phone: phoneField.nullable().optional(),
    email: emailField.nullable().optional(),
    notes: notesField.nullable().optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type FinancePartyUpdateInput = z.infer<typeof financePartyUpdateSchema>;

export const financePartyListQuerySchema = z.object({
  type: multiEnum(partyTypeValues).optional(),
  isActive: boolFromQuery.optional(),
  search: z
    .string()
    .trim()
    .min(1, 'Search query cannot be empty')
    .max(MAX_SEARCH_LENGTH)
    .optional(),
  page: pageField,
  pageSize: pageSizeField,
});

export type FinancePartyListQuery = z.infer<typeof financePartyListQuerySchema>;

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** Credit-card sanctioned limit, INR. */
const creditLimitField = z.coerce
  .number()
  .min(0, 'Credit limit cannot be negative')
  .max(MAX_AMOUNT, 'Credit limit is unrealistically large');

/** Day of month for statement generation / payment due. */
const dayOfMonthField = z.coerce
  .number()
  .int('Must be a whole day of the month')
  .min(1, 'Day must be between 1 and 31')
  .max(31, 'Day must be between 1 and 31');

export const financeAccountCreateSchema = z.object({
  name: nameField,
  type: accountTypeField.default(FinanceAccountType.BANK),
  ownerPartyId: idField.optional(),
  openingBalance: signedAmountField.optional().default(0),
  notes: notesField.optional(),
  isActive: z.boolean().optional().default(true),
  creditLimit: creditLimitField.optional(),
  billingDay: dayOfMonthField.optional(),
  dueDay: dayOfMonthField.optional(),
});

export type FinanceAccountCreateInput = z.infer<typeof financeAccountCreateSchema>;

export const financeAccountUpdateSchema = z
  .object({
    name: nameField.optional(),
    type: accountTypeField.optional(),
    ownerPartyId: idField.nullable().optional(),
    openingBalance: signedAmountField.optional(),
    notes: notesField.nullable().optional(),
    isActive: z.boolean().optional(),
    creditLimit: creditLimitField.nullable().optional(),
    billingDay: dayOfMonthField.nullable().optional(),
    dueDay: dayOfMonthField.nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export type FinanceAccountUpdateInput = z.infer<typeof financeAccountUpdateSchema>;

export const financeAccountListQuerySchema = z.object({
  type: multiEnum(accountTypeValues).optional(),
  isActive: boolFromQuery.optional(),
  ownerPartyId: idField.optional(),
});

export type FinanceAccountListQuery = z.infer<typeof financeAccountListQuerySchema>;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Query for `GET /api/finance/summary`. Either a `month` key or an
 * explicit `dateFrom`/`dateTo`; the route defaults to the current UTC
 * month when nothing is given.
 */
export const financeSummaryQuerySchema = z
  .object({
    month: monthKeyField.optional(),
    dateFrom: dateField.optional(),
    dateTo: dateField.optional(),
  })
  .refine(
    (val) => !val.dateFrom || !val.dateTo || val.dateFrom <= val.dateTo,
    { message: 'dateFrom must be on or before dateTo', path: ['dateFrom'] },
  );

export type FinanceSummaryQuery = z.infer<typeof financeSummaryQuerySchema>;

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

export const financePartyProjection = {
  id: true,
  name: true,
  type: true,
  phone: true,
  email: true,
  notes: true,
  isActive: true,
  userId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} as const;

export type FinancePartyPublic = {
  id: string;
  name: string;
  type: FinancePartyType;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
  /** Panel user this party represents (type EMPLOYEE), if any. */
  userId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
};

export const financeAccountProjection = {
  id: true,
  name: true,
  type: true,
  ownerPartyId: true,
  openingBalance: true,
  isActive: true,
  notes: true,
  creditLimit: true,
  billingDay: true,
  dueDay: true,
  createdAt: true,
  updatedAt: true,
  ownerParty: {
    select: { id: true, name: true, type: true },
  },
} as const;

export type FinanceAccountPublic = {
  id: string;
  name: string;
  type: FinanceAccountType;
  ownerPartyId: string | null;
  openingBalance: number;
  isActive: boolean;
  notes: string | null;
  /** Credit cards only. */
  creditLimit: number | null;
  billingDay: number | null;
  dueDay: number | null;
  createdAt: Date;
  updatedAt: Date;
  ownerParty: { id: string; name: string; type: FinancePartyType } | null;
};

export const financeTransactionProjection = {
  id: true,
  date: true,
  direction: true,
  category: true,
  amount: true,
  originalAmount: true,
  originalCurrency: true,
  description: true,
  reference: true,
  dueDate: true,
  partyId: true,
  viaPartyId: true,
  accountId: true,
  settlesAccountId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
  party: {
    select: { id: true, name: true, type: true },
  },
  viaParty: {
    select: { id: true, name: true, type: true },
  },
  settlesAccount: {
    select: { id: true, name: true },
  },
  account: {
    select: { id: true, name: true, type: true, ownerPartyId: true },
  },
  createdBy: {
    select: { id: true, name: true },
  },
} as const;

export type FinanceTransactionPublic = {
  id: string;
  date: Date;
  direction: FinanceDirection;
  category: FinanceCategory;
  amount: number;
  originalAmount: number | null;
  originalCurrency: string | null;
  description: string | null;
  reference: string | null;
  dueDate: Date | null;
  partyId: string | null;
  viaPartyId: string | null;
  accountId: string | null;
  settlesAccountId: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  party: { id: string; name: string; type: FinancePartyType } | null;
  viaParty: { id: string; name: string; type: FinancePartyType } | null;
  settlesAccount: { id: string; name: string } | null;
  account: {
    id: string;
    name: string;
    type: FinanceAccountType;
    ownerPartyId: string | null;
  } | null;
  createdBy: { id: string; name: string };
};
