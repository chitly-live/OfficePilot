/**
 * Validation for the asset register (`/api/finance/assets`).
 *
 * An asset's holder is not a field on the asset: it is the open assignment.
 * Creating an asset may hand it to someone straight away (`holder`), and
 * every later move goes through the assign endpoint so the trail is kept.
 */

import { AssetKind, AssetStatus, Prisma } from '@prisma/client';
import { z } from 'zod';

import {
  financeAmountField,
  financeDateField,
  financeIdField,
  financeNameField,
  financeNotesField,
} from '@/lib/schemas/finance';

const shortText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} must be ${max} characters or fewer`);

const kindField = z.nativeEnum(AssetKind);
const statusField = z.nativeEnum(AssetStatus);

/** Where the asset goes. Neither user nor party = back with the company. */
export const assetHolderSchema = z
  .object({
    toUserId: financeIdField.nullable().optional(),
    toPartyId: financeIdField.nullable().optional(),
    location: shortText(120, 'Location').optional(),
    note: shortText(500, 'Note').optional(),
  })
  .refine((v) => !(v.toUserId && v.toPartyId), {
    message: 'Hand it to a team member or a party, not both',
    path: ['toPartyId'],
  });

export const assetCreateSchema = z.object({
  name: financeNameField,
  kind: kindField.default('PHYSICAL'),
  category: shortText(60, 'Category').optional(),
  identifier: shortText(120, 'Serial / IMEI / number').optional(),
  purchaseDate: financeDateField.optional(),
  cost: financeAmountField.optional(),
  transactionId: financeIdField.optional(),
  status: statusField.optional(),
  renewsOn: financeDateField.optional(),
  notes: financeNotesField.optional(),
  productId: financeIdField.optional(),
  /** Hand it over on creation; the assignment starts on `purchaseDate` (or today). */
  holder: assetHolderSchema.optional(),
});

export type AssetCreateInput = z.infer<typeof assetCreateSchema>;

export const assetUpdateSchema = z
  .object({
    name: financeNameField.optional(),
    kind: kindField.optional(),
    category: shortText(60, 'Category').nullable().optional(),
    identifier: shortText(120, 'Serial / IMEI / number').nullable().optional(),
    purchaseDate: financeDateField.nullable().optional(),
    cost: financeAmountField.nullable().optional(),
    transactionId: financeIdField.nullable().optional(),
    status: statusField.optional(),
    renewsOn: financeDateField.nullable().optional(),
    notes: financeNotesField.nullable().optional(),
    productId: financeIdField.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

export type AssetUpdateInput = z.infer<typeof assetUpdateSchema>;

/** `POST /api/finance/assets/[id]/assign` — a handover or a return. */
export const assetAssignSchema = z
  .object({
    toUserId: financeIdField.nullable().optional(),
    toPartyId: financeIdField.nullable().optional(),
    location: shortText(120, 'Location').optional(),
    note: shortText(500, 'Note').optional(),
    date: financeDateField,
    /** Override the automatic IN_USE / IN_STOCK (e.g. REPAIR at a service centre). */
    status: statusField.optional(),
  })
  .refine((v) => !(v.toUserId && v.toPartyId), {
    message: 'Hand it to a team member or a party, not both',
    path: ['toPartyId'],
  });

export type AssetAssignInput = z.infer<typeof assetAssignSchema>;

export const assetListQuerySchema = z.object({
  status: statusField.optional(),
  kind: kindField.optional(),
  /** `user:<id>`, `party:<id>` or `company`. */
  holder: z.string().trim().max(80).optional(),
  search: z.string().trim().max(200).optional(),
});

export const assetProjection = Prisma.validator<Prisma.AssetSelect>()({
  id: true,
  name: true,
  kind: true,
  category: true,
  identifier: true,
  purchaseDate: true,
  cost: true,
  transactionId: true,
  status: true,
  renewsOn: true,
  notes: true,
  productId: true,
  createdAt: true,
  updatedAt: true,
  transaction: {
    select: {
      id: true,
      date: true,
      amount: true,
      description: true,
      account: { select: { id: true, name: true } },
    },
  },
  assignments: {
    select: {
      id: true,
      fromDate: true,
      toDate: true,
      location: true,
      note: true,
      toUser: { select: { id: true, name: true } },
      toParty: { select: { id: true, name: true } },
      createdBy: { select: { name: true } },
    },
    orderBy: [{ fromDate: 'desc' }, { createdAt: 'desc' }],
  },
});

export type AssetPublic = Prisma.AssetGetPayload<{ select: typeof assetProjection }>;
