/**
 * Two-column ledger for a party page: money in on one side, money out on the
 * other, the way a hand-written ledger reads. Card settlements live in their
 * own section (see `CardAdjustments`) so the running balance here is only the
 * work done with this party.
 *
 * Server component — everything arrives computed.
 */

import Link from 'next/link';

import { StatusBadge } from '@/components/shared/StatusBadge';
import { FINANCE_CATEGORY_META, formatDateUtc, formatInr } from '@/lib/finance';
import {
  buildPartyLedger,
  hasRunningBalance,
  sumPartyLedger,
  type PartyLedgerSource,
} from '@/lib/party-ledger';
import type { FinanceTransactionPublic } from '@/lib/schemas/finance';
import { cn } from '@/lib/utils';

import { directionTone } from '../../finance-ui';

export interface PartyLedgerProps {
  rows: FinanceTransactionPublic[];
  /** Ids of accounts this party owns — spend there is money of theirs we used. */
  theirAccountIds: string[];
  /** All-time "we owe" from computePartyBalance, so the balance column is right. */
  closingOwed: number;
  /** Shown when there is nothing to list. */
  emptyText: string;
  readOnly?: boolean;
}

export function PartyLedger({
  rows,
  theirAccountIds,
  closingOwed,
  emptyText,
  readOnly = false,
}: PartyLedgerProps) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  const owned = new Set(theirAccountIds);
  const source: PartyLedgerSource[] = rows.map((r) => ({
    id: r.id,
    date: r.date,
    direction: r.direction,
    category: r.category,
    amount: r.amount,
    onTheirAccount: r.accountId !== null && owned.has(r.accountId),
  }));
  const lines = buildPartyLedger(source, closingOwed);
  const totals = sumPartyLedger(lines.values());
  const showBalance = hasRunningBalance(totals);
  const showReceived = totals.received > 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 font-medium">Description</th>
            <th className="py-2 pr-3 font-medium">Account</th>
            <th className="py-2 pr-3 text-right font-medium text-status-red">Used</th>
            <th className="py-2 pr-3 text-right font-medium text-status-green">Paid</th>
            {showReceived ? (
              <th className="py-2 pr-3 text-right font-medium text-status-green">Received</th>
            ) : null}
            {showBalance ? (
              <th className="py-2 pr-3 text-right font-medium">Balance</th>
            ) : null}
            {readOnly ? null : (
              <th className="py-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((t) => {
            const meta = FINANCE_CATEGORY_META[t.category];
            const primary = t.description || t.party?.name || meta.label;
            const line = lines.get(t.id);
            return (
              <tr key={t.id}>
                <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                  {formatDateUtc(t.date)}
                </td>
                <td className="py-2 pr-3">
                  <div className="min-w-0 max-w-sm">
                    <span className="block truncate font-medium text-foreground">{primary}</span>
                    <span className="mt-0.5 inline-flex items-center gap-1">
                      <StatusBadge
                        status={t.category}
                        tone={directionTone(t.direction)}
                        label={meta.label}
                      />
                      {t.viaParty ? (
                        <span className="text-[11px] text-status-amber">
                          via {t.viaParty.name}
                        </span>
                      ) : null}
                    </span>
                    {t.reference ? (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {t.reference}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td className="py-2 pr-3 text-muted-foreground">{t.account?.name ?? '—'}</td>
                <td className="py-2 pr-3 text-right tabular-nums text-status-red">
                  {line && line.used > 0 ? formatInr(line.used) : ''}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                  {line && line.paid > 0 ? formatInr(line.paid) : ''}
                </td>
                {showReceived ? (
                  <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                    {line && line.received > 0 ? formatInr(line.received) : ''}
                  </td>
                ) : null}
                {showBalance ? (
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                    {line ? formatInr(line.balanceAfter) : ''}
                  </td>
                ) : null}
                {readOnly ? null : (
                  <td className="py-2 text-right">
                    <Link
                      href={`/finance/transactions/${t.id}`}
                      className="text-xs font-medium text-primary hover:underline"
                    >
                      Edit
                    </Link>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold">
            <td className="py-2 pr-3" colSpan={3}>
              Total
            </td>
            <td className="py-2 pr-3 text-right tabular-nums text-status-red">
              {formatInr(totals.used)}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums text-status-green">
              {formatInr(totals.paid)}
            </td>
            {showReceived ? (
              <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                {formatInr(totals.received)}
              </td>
            ) : null}
            {showBalance ? (
              <td className="py-2 pr-3 text-right tabular-nums">{formatInr(closingOwed)}</td>
            ) : null}
            {readOnly ? null : <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface CardAdjustmentsCard {
  id: string;
  name: string;
  creditLimit: number | null;
  spend: number;
  repaid: number;
  outstanding: number;
}

export interface CardAdjustmentsProps {
  cards: CardAdjustmentsCard[];
}

/**
 * Card-by-card reconciliation for a card owner. The individual transfers stay
 * in the ledger above — this is the per-card view of the same money, so no
 * payment is ever listed twice.
 */
export function CardAdjustments({ cards }: CardAdjustmentsProps) {
  if (cards.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        Nothing spent on their cards yet.
      </p>
    );
  }

  const total = cards.reduce(
    (acc, c) => ({
      spend: acc.spend + c.spend,
      repaid: acc.repaid + c.repaid,
      outstanding: acc.outstanding + c.outstanding,
    }),
    { spend: 0, repaid: 0, outstanding: 0 },
  );

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Card</th>
            <th className="py-2 pr-3 text-right font-medium text-status-red">Used</th>
            <th className="py-2 pr-3 text-right font-medium text-status-green">Settled</th>
            <th className="py-2 pr-3 text-right font-medium">Still owed</th>
            <th className="py-2 text-right font-medium">Limit left</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {cards.map((c) => (
            <tr key={c.id}>
              <td className="py-2 pr-3 font-medium text-foreground">{c.name}</td>
              <td className="py-2 pr-3 text-right tabular-nums text-status-red">
                {formatInr(c.spend)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                {c.repaid > 0 ? formatInr(c.repaid) : ''}
              </td>
              <td
                className={cn(
                  'py-2 pr-3 text-right font-semibold tabular-nums',
                  c.outstanding > 0 ? 'text-status-red' : 'text-status-green',
                )}
              >
                {formatInr(c.outstanding)}
              </td>
              <td className="py-2 text-right tabular-nums text-muted-foreground">
                {c.creditLimit ? formatInr(c.creditLimit - c.outstanding) : '—'}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 font-semibold">
            <td className="py-2 pr-3">Total</td>
            <td className="py-2 pr-3 text-right tabular-nums text-status-red">
              {formatInr(total.spend)}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums text-status-green">
              {formatInr(total.repaid)}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums">{formatInr(total.outstanding)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
