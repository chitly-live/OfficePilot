/**
 * Asset register helpers.
 *
 * Where an asset is right now is its open assignment (`toDate = null`); a
 * handover closes that row and opens the next, so "who had it when" is
 * never overwritten. Money stays in the ledger — an asset only points at
 * the transaction that paid for it.
 */

import type { AssetKind, AssetStatus, Prisma } from '@prisma/client';

import { round2 } from '@/lib/finance';
import type { FinanceDbClient } from '@/lib/finance-summary';
import { BadRequestError } from '@/lib/http-errors';

export const ASSET_STATUS_LABELS: Record<AssetStatus, string> = {
  IN_USE: 'In use',
  IN_STOCK: 'In stock',
  REPAIR: 'At repair',
  LOST: 'Lost',
  SOLD: 'Sold',
  SCRAPPED: 'Scrapped',
};

export const ASSET_STATUS_TONE: Record<AssetStatus, 'green' | 'blue' | 'amber' | 'red' | 'neutral'> = {
  IN_USE: 'green',
  IN_STOCK: 'blue',
  REPAIR: 'amber',
  LOST: 'red',
  SOLD: 'neutral',
  SCRAPPED: 'neutral',
};

export const ASSET_KIND_LABELS: Record<AssetKind, string> = {
  PHYSICAL: 'Physical',
  DIGITAL: 'Digital',
};

/** Suggestions for the category box; free text is still allowed. */
export const ASSET_CATEGORY_SUGGESTIONS = [
  'Laptop',
  'Phone',
  'SIM',
  'Tablet',
  'Monitor',
  'Accessory',
  'Furniture',
  'Domain',
  'Subscription',
  'Software licence',
] as const;

/** Statuses for things that have left the company for good. */
export const GONE_STATUSES: readonly AssetStatus[] = ['SOLD', 'SCRAPPED'];

// ---------------------------------------------------------------------------
// Holder
// ---------------------------------------------------------------------------

export interface AssignmentLike {
  fromDate: Date;
  toDate: Date | null;
  location: string | null;
  toUser: { id: string; name: string } | null;
  toParty: { id: string; name: string } | null;
}

export interface CurrentHolder {
  kind: 'user' | 'party' | 'company';
  id: string | null;
  name: string;
  location: string | null;
  since: Date | null;
}

const COMPANY: CurrentHolder = { kind: 'company', id: null, name: 'Company', location: null, since: null };

/** Who has the asset now, from its assignments (any order). */
export function currentHolder(assignments: readonly AssignmentLike[]): CurrentHolder {
  const open = assignments
    .filter((a) => a.toDate === null)
    .sort((a, b) => b.fromDate.getTime() - a.fromDate.getTime())[0];
  if (!open) return COMPANY;
  if (open.toUser) {
    return { kind: 'user', id: open.toUser.id, name: open.toUser.name, location: open.location, since: open.fromDate };
  }
  if (open.toParty) {
    return { kind: 'party', id: open.toParty.id, name: open.toParty.name, location: open.location, since: open.fromDate };
  }
  return { ...COMPANY, location: open.location, since: open.fromDate };
}

/** The status a handover implies unless the user picked one. */
export function statusAfterHandover(
  target: { toUserId?: string | null; toPartyId?: string | null },
  chosen?: AssetStatus,
): AssetStatus {
  if (chosen) return chosen;
  return target.toUserId || target.toPartyId ? 'IN_USE' : 'IN_STOCK';
}

// ---------------------------------------------------------------------------
// Renewals + summary
// ---------------------------------------------------------------------------

export type RenewalState = 'overdue' | 'soon' | 'ok';

/** Within 30 days = soon. Dates are UTC days. */
export function renewalState(renewsOn: Date | null, today: Date): RenewalState | null {
  if (!renewsOn) return null;
  const day = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const diff = Math.round((renewsOn.getTime() - day) / (24 * 60 * 60 * 1000));
  if (diff < 0) return 'overdue';
  if (diff <= 30) return 'soon';
  return 'ok';
}

export interface AssetSummaryInput {
  status: AssetStatus;
  cost: number | null;
  renewsOn: Date | null;
}

export interface AssetSummary {
  /** Everything not sold / scrapped. */
  owned: number;
  /** What the owned ones cost. */
  ownedCost: number;
  inUse: number;
  inStock: number;
  away: number;
  lost: number;
  renewalsDue: number;
}

export function summarizeAssets(assets: readonly AssetSummaryInput[], today: Date): AssetSummary {
  let owned = 0;
  let ownedCost = 0;
  let inUse = 0;
  let inStock = 0;
  let away = 0;
  let lost = 0;
  let renewalsDue = 0;
  for (const a of assets) {
    if (GONE_STATUSES.includes(a.status)) continue;
    owned++;
    ownedCost += a.cost ?? 0;
    if (a.status === 'IN_USE') inUse++;
    else if (a.status === 'IN_STOCK') inStock++;
    else if (a.status === 'REPAIR') away++;
    else if (a.status === 'LOST') lost++;
    const r = renewalState(a.renewsOn, today);
    if (r === 'overdue' || r === 'soon') renewalsDue++;
  }
  return { owned, ownedCost: round2(ownedCost), inUse, inStock, away, lost, renewalsDue };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Record a handover: close the open assignment on `date` and open the next.
 * A handover dated before the current holder got it is refused — the trail
 * would otherwise overlap.
 */
export async function handOver(
  tx: Prisma.TransactionClient,
  assetId: string,
  target: { toUserId?: string | null; toPartyId?: string | null; location?: string; note?: string },
  date: Date,
  createdById: string,
): Promise<void> {
  const open = await tx.assetAssignment.findFirst({
    where: { assetId, toDate: null },
    orderBy: { fromDate: 'desc' },
    select: { id: true, fromDate: true },
  });
  if (open) {
    if (date.getTime() < open.fromDate.getTime()) {
      throw new BadRequestError('The handover date is before the current holder received it');
    }
    await tx.assetAssignment.update({ where: { id: open.id }, data: { toDate: date } });
  }
  await tx.assetAssignment.create({
    data: {
      assetId,
      toUserId: target.toUserId ?? null,
      toPartyId: target.toPartyId ?? null,
      location: target.location?.trim() || null,
      note: target.note?.trim() || null,
      fromDate: date,
      createdById,
    },
  });
}

/** Close the open assignment without opening another (sold / scrapped). */
export async function closeOpenAssignment(
  tx: Prisma.TransactionClient,
  assetId: string,
  date: Date,
): Promise<void> {
  await tx.assetAssignment.updateMany({
    where: { assetId, toDate: null },
    data: { toDate: date },
  });
}

/** Check a user / party / transaction / product reference exists. */
export async function assertAssetRefs(
  db: FinanceDbClient,
  refs: {
    toUserId?: string | null;
    toPartyId?: string | null;
    transactionId?: string | null;
    productId?: string | null;
    /** Skip "already linked" for this asset (edit). */
    assetId?: string;
  },
): Promise<void> {
  if (refs.toUserId) {
    const u = await db.user.findUnique({ where: { id: refs.toUserId }, select: { id: true } });
    if (!u) throw new BadRequestError('Team member not found');
  }
  if (refs.toPartyId) {
    const p = await db.financeParty.findUnique({ where: { id: refs.toPartyId }, select: { id: true } });
    if (!p) throw new BadRequestError('Party not found');
  }
  if (refs.productId) {
    const p = await db.product.findUnique({ where: { id: refs.productId }, select: { id: true } });
    if (!p) throw new BadRequestError('Product not found');
  }
  if (refs.transactionId) {
    const t = await db.financeTransaction.findUnique({
      where: { id: refs.transactionId },
      select: { id: true, direction: true, asset: { select: { id: true, name: true } } },
    });
    if (!t) throw new BadRequestError('Transaction not found');
    if (t.direction !== 'OUT') throw new BadRequestError('An asset is paid for by money going out');
    if (t.asset && t.asset.id !== refs.assetId) {
      throw new BadRequestError(`That payment is already linked to ${t.asset.name}`);
    }
  }
}
