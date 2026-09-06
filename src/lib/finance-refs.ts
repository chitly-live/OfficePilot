/**
 * Reference validation for Finance writes.
 *
 * A transaction may point at a `FinanceParty` (the real counterparty), an
 * optional `viaParty` (intermediary the bank paid when money was routed),
 * a `FinanceAccount` (where the money moved) and, for card repayments, a
 * `settlesAccount` (which credit card's bill it clears). Each is looked up
 * once; a dangling id becomes a 400 rather than a Prisma foreign-key error.
 */

import { BadRequestError } from '@/lib/api-helpers';
import type { FinanceDbClient } from '@/lib/finance-summary';

export interface ResolvedTransactionRefs {
  partyName: string | null;
  viaPartyName: string | null;
  accountName: string | null;
  settlesAccountName: string | null;
}

export async function resolveTransactionRefs(
  db: FinanceDbClient,
  refs: {
    partyId?: string | null;
    viaPartyId?: string | null;
    accountId?: string | null;
    settlesAccountId?: string | null;
  },
): Promise<ResolvedTransactionRefs> {
  const [party, viaParty, account, settlesAccount] = await Promise.all([
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
    refs.settlesAccountId
      ? db.financeAccount.findUnique({
          where: { id: refs.settlesAccountId },
          select: { id: true, name: true, type: true },
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
  if (refs.settlesAccountId && !settlesAccount) {
    throw new BadRequestError('Settled card not found');
  }
  if (settlesAccount && settlesAccount.type !== 'CREDIT_CARD') {
    throw new BadRequestError('A repayment can only settle a credit card');
  }

  return {
    partyName: party?.name ?? null,
    viaPartyName: viaParty?.name ?? null,
    accountName: account?.name ?? null,
    settlesAccountName: settlesAccount?.name ?? null,
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
