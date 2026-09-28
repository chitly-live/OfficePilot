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
import type { FinanceTransactionPublic } from '@/lib/schemas/finance';
import { cn } from '@/lib/utils';

import { directionTone } from '../../finance-ui';

export interface PartyLedgerProps {
  rows: FinanceTransactionPublic[];
  /** Shown when there is nothing to list. */
  emptyText: string;
  readOnly?: boolean;
}

export function PartyLedger({ rows, emptyText, readOnly = false }: PartyLedgerProps) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;
  }

  const totalIn = rows.reduce((s, r) => (r.direction === 'IN' ? s + r.amount : s), 0);
  const totalOut = rows.reduce((s, r) => (r.direction === 'OUT' ? s + r.amount : s), 0);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th className="py-2 pr-3 font-medium">Date</th>
            <th className="py-2 pr-3 font-medium">Description</th>
            <th className="py-2 pr-3 font-medium">Account</th>
            <th className="py-2 pr-3 text-right font-medium text-status-green">In</th>
            <th className="py-2 pr-3 text-right font-medium text-status-red">Out</th>
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
                <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                  {t.direction === 'IN' ? formatInr(t.amount) : ''}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-status-red">
                  {t.direction === 'OUT' ? formatInr(t.amount) : ''}
                </td>
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
            <td className="py-2 pr-3 text-right tabular-nums text-status-green">
              {formatInr(totalIn)}
            </td>
            <td className="py-2 pr-3 text-right tabular-nums text-status-red">
              {formatInr(totalOut)}
            </td>
            {readOnly ? null : <td />}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

export interface CardAdjustmentsProps {
  rows: FinanceTransactionPublic[];
  /** All-time spend on this party's cards, for the closing line. */
  cardSpend: number;
  cardOutstanding: number;
  readOnly?: boolean;
}

/**
 * Settlements against a card owner, kept apart from the working ledger.
 * A single payment that cleared several cards shows its per-card split
 * underneath — the payment itself stays one row, as the bank shows it.
 */
export function CardAdjustments({
  rows,
  cardSpend,
  cardOutstanding,
  readOnly = false,
}: CardAdjustmentsProps) {
  if (rows.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No card settlements recorded yet.
      </p>
    );
  }

  const settled = rows.reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Date</th>
              <th className="py-2 pr-3 font-medium">Paid from</th>
              <th className="py-2 pr-3 font-medium">Applied to</th>
              <th className="py-2 pr-3 text-right font-medium">Amount</th>
              {readOnly ? null : (
                <th className="py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.map((t) => {
              const split = t.cardAllocations ?? [];
              return (
                <tr key={t.id}>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {formatDateUtc(t.date)}
                  </td>
                  <td className="py-2 pr-3 text-muted-foreground">
                    {t.account?.name ?? '—'}
                    {t.viaParty ? (
                      <span className="ml-1 text-[11px] text-status-amber">
                        via {t.viaParty.name}
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3">
                    {split.length > 0 ? (
                      <ul className="space-y-0.5">
                        {split.map((a) => (
                          <li key={a.id} className="flex items-baseline gap-2">
                            <span className="text-foreground">{a.account.name}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {formatInr(a.amount)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : t.settlesAccount ? (
                      <span className="text-foreground">{t.settlesAccount.name}</span>
                    ) : (
                      <span className="text-status-amber">not assigned</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                    {formatInr(t.amount)}
                  </td>
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
                Total settled
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">{formatInr(settled)}</td>
              {readOnly ? null : <td />}
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">Spent on their cards</span>
          <span className="tabular-nums">{formatInr(cardSpend)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-muted-foreground">Settled so far</span>
          <span className="tabular-nums">− {formatInr(settled)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 border-t pt-1">
          <span className="font-medium text-foreground">Still on their cards</span>
          <span
            className={cn(
              'font-semibold tabular-nums',
              cardOutstanding > 0 ? 'text-status-red' : 'text-status-green',
            )}
          >
            {formatInr(cardOutstanding)}
          </span>
        </div>
      </div>
    </div>
  );
}
