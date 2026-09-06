/**
 * Reference validation for Finance writes.
 *
 * A transaction may point at a `FinanceParty` (the real counterparty), an
 * optional `viaParty` (intermediary the bank paid when money was routed)
 * and a `FinanceAccount`. Each is looked up once; a dangling id becomes a
 * 400 rather than a Prisma foreign-key error.
 */

import { BadRequestError } from '@/lib/api-helpers';
import type { FinanceDbClient } from '@/lib/finance-summary';

export interface ResolvedTransactionRefs {
  partyName: string | null;
  viaPartyName: string | null;
  accountName: string | null;
}

export async function resolveTransactionRefs(
  db: FinanceDbClient,
  refs: {
    partyId?: string | null;
    viaPartyId?: string | null;
    accountId?: string | null;
  },
): Promise<ResolvedTransactionRefs> {
  const [party, viaParty, account] = await Promise.all([
    refs.partyId
      ? db.financeParty.findUnique({
          where: { id: refs.partyId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    refs.viaPartyId
      ? db.financeParty.findUnique({
          where: { id: refs.viaPartyId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    refs.accountId
      ? db.financeAccount.findUnique({
          where: { id: refs.accountId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
  ]);

  if (refs.partyId && !party) {
    throw new BadRequestError('Party not found');
  }
  if (refs.viaPartyId && !viaParty) {
    throw new BadRequestError('Routed-via party not found');
  }
  if (refs.accountId && !account) {
    throw new BadRequestError('Account not found');
  }

  return {
    partyName: party?.name ?? null,
    viaPartyName: viaParty?.name ?? null,
    accountName: account?.name ?? null,
  };
}

export async function resolveOwnerParty(
  db: FinanceDbClient,
  ownerPartyId: string | null | undefined,
): Promise<{ id: string; name: string } | null> {
  if (!ownerPartyId) return null;
  const party = await db.financeParty.findUnique({
    where: { id: ownerPartyId },
    select: { id: true, name: true },
  });
  if (!party) {
    throw new BadRequestError('Owner party not found');
  }
  return party;
}
