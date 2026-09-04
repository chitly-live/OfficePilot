/**
 * Finance module — reference validation shared by the transaction and
 * account route handlers.
 *
 * A transaction may point at a `FinanceParty` and a `FinanceAccount`; an
 * account may point at an owner party. Prisma would surface a dangling id
 * as a P2003 foreign-key error (→ 500), which is the wrong status for a
 * client typo. These helpers turn a missing reference into a
 * {@link BadRequestError} (→ 400) with a readable message and hand back
 * the display names so the caller can enrich the activity log.
 */

import { BadRequestError } from '@/lib/api-helpers';
import type { FinanceDbClient } from '@/lib/finance-summary';

export interface ResolvedTransactionRefs {
  partyName: string | null;
  accountName: string | null;
}

/**
 * Ensure the party / account ids exist. `undefined` and `null` are both
 * "no reference" and skip the lookup.
 */
export async function resolveTransactionRefs(
  db: FinanceDbClient,
  refs: { partyId?: string | null; accountId?: string | null },
): Promise<ResolvedTransactionRefs> {
  const [party, account] = await Promise.all([
    refs.partyId
      ? db.financeParty.findUnique({
          where: { id: refs.partyId },
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
  if (refs.accountId && !account) {
    throw new BadRequestError('Account not found');
  }

  return {
    partyName: party?.name ?? null,
    accountName: account?.name ?? null,
  };
}

/** Ensure an account's owner party exists (when one is given). */
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
