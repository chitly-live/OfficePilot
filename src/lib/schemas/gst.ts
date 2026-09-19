/**
 * Zod schemas for `/api/finance/gst` — monthly GST returns.
 */

import { z } from 'zod';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const gstMonthField = z
  .string()
  .trim()
  .regex(MONTH_RE, 'Month must look like YYYY-MM');

const rupees = z.coerce
  .number()
  .finite()
  .min(0, 'Cannot be negative')
  .max(100_000_000, 'Too large')
  .transform((v) => Math.round(v * 100) / 100);

const dateField = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
  .transform((v) => new Date(`${v}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()), 'Invalid date');

const idField = z.string().trim().min(1).max(64);
const shortText = z.string().trim().max(120);
const longText = z.string().trim().max(2000);

/** The three GST heads, in filing order. */
export const GST_HEADS = ['igst', 'cgst', 'sgst'] as const;
export type GstHead = (typeof GST_HEADS)[number];

export const GST_HEAD_LABELS: Record<GstHead, string> = {
  igst: 'IGST',
  cgst: 'CGST',
  sgst: 'SGST',
};

const base = {
  /** ITC claimed this period (credit earned; no cash, no ledger row). */
  itcClaimed: rupees.default(0),
  itcUsed: rupees.default(0),
  cashPaid: rupees.default(0),
  // Head-wise split. When any of these is sent, the totals above are derived.
  itcClaimedIgst: rupees.default(0),
  itcClaimedCgst: rupees.default(0),
  itcClaimedSgst: rupees.default(0),
  itcUsedIgst: rupees.default(0),
  itcUsedCgst: rupees.default(0),
  itcUsedSgst: rupees.default(0),
  cashPaidIgst: rupees.default(0),
  cashPaidCgst: rupees.default(0),
  cashPaidSgst: rupees.default(0),
  paidOn: dateField.nullable().optional(),
  /** Bank / card the cash left from. Optional — can be filled in later. */
  cashAccountId: idField.nullable().optional(),
  reference: shortText.nullable().optional(),
  notes: longText.nullable().optional(),
};

/**
 * The head-wise numbers are what the accountant actually files, so when any
 * of them is non-zero the flat totals are derived from them. A caller that
 * sends only totals (older clients, the August row entered by hand) keeps
 * working unchanged.
 */
export function withDerivedTotals<T extends Record<string, number | unknown>>(v: T): T {
  const sum = (a: unknown, b: unknown, c: unknown) =>
    Math.round(((Number(a) || 0) + (Number(b) || 0) + (Number(c) || 0)) * 100) / 100;
  const claimed = sum(v.itcClaimedIgst, v.itcClaimedCgst, v.itcClaimedSgst);
  const used = sum(v.itcUsedIgst, v.itcUsedCgst, v.itcUsedSgst);
  const cash = sum(v.cashPaidIgst, v.cashPaidCgst, v.cashPaidSgst);
  if (claimed === 0 && used === 0 && cash === 0) return v;
  return { ...v, itcClaimed: claimed, itcUsed: used, cashPaid: cash };
}

export const gstReturnCreateSchema = z
  .object({ month: gstMonthField, ...base })
  .transform(withDerivedTotals)
  .refine((v) => v.itcClaimed > 0 || v.itcUsed > 0 || v.cashPaid > 0, {
    message: 'Enter at least one amount: ITC claimed, ITC used or cash paid',
    path: ['cashPaid'],
  });

export type GstReturnCreateInput = z.infer<typeof gstReturnCreateSchema>;

export const gstReturnUpdateSchema = z
  .object({
    itcClaimed: rupees.optional(),
    itcUsed: rupees.optional(),
    cashPaid: rupees.optional(),
    itcClaimedIgst: rupees.optional(),
    itcClaimedCgst: rupees.optional(),
    itcClaimedSgst: rupees.optional(),
    itcUsedIgst: rupees.optional(),
    itcUsedCgst: rupees.optional(),
    itcUsedSgst: rupees.optional(),
    cashPaidIgst: rupees.optional(),
    cashPaidCgst: rupees.optional(),
    cashPaidSgst: rupees.optional(),
    paidOn: dateField.nullable().optional(),
    cashAccountId: idField.nullable().optional(),
    reference: shortText.nullable().optional(),
    notes: longText.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export type GstReturnUpdateInput = z.infer<typeof gstReturnUpdateSchema>;

export const gstReturnProjection = {
  id: true,
  month: true,
  itcClaimed: true,
  itcUsed: true,
  cashPaid: true,
  itcClaimedIgst: true,
  itcClaimedCgst: true,
  itcClaimedSgst: true,
  itcUsedIgst: true,
  itcUsedCgst: true,
  itcUsedSgst: true,
  cashPaidIgst: true,
  cashPaidCgst: true,
  cashPaidSgst: true,
  paidOn: true,
  cashAccountId: true,
  cashAccount: { select: { id: true, name: true, type: true } },
  reference: true,
  notes: true,
  cashTransactionId: true,
  itcTransactionId: true,
  createdById: true,
  createdBy: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
} as const;

export type GstReturnPublic = {
  id: string;
  month: string;
  itcClaimed: number;
  itcUsed: number;
  cashPaid: number;
  itcClaimedIgst: number;
  itcClaimedCgst: number;
  itcClaimedSgst: number;
  itcUsedIgst: number;
  itcUsedCgst: number;
  itcUsedSgst: number;
  cashPaidIgst: number;
  cashPaidCgst: number;
  cashPaidSgst: number;
  paidOn: Date | null;
  cashAccountId: string | null;
  cashAccount: { id: string; name: string; type: string } | null;
  reference: string | null;
  notes: string | null;
  cashTransactionId: string | null;
  itcTransactionId: string | null;
  createdById: string;
  createdBy: { id: string; name: string | null };
  createdAt: Date;
  updatedAt: Date;
};
