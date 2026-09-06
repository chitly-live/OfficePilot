'use client';

/**
 * Ledger table. Shared by `/finance/transactions` and the party detail
 * page (`showParty` hides the party column there).
 */

import * as React from 'react';
import Link from 'next/link';
import { Plus, Receipt } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import {
  FINANCE_CATEGORY_META,
  formatDateUtc,
  formatInr,
} from '@/lib/finance';
import type { FinanceTransactionPublic } from '@/lib/schemas/finance';
import { cn } from '@/lib/utils';

import { amountClass, amountSign, directionTone } from '../finance-ui';

export interface TransactionsTableProps {
  items: FinanceTransactionPublic[];
  showParty?: boolean;
  /** Prefilled "new" link for the empty state. */
  newHref?: string;
}

export function TransactionsTable({
  items,
  showParty = true,
  newHref = '/finance/transactions/new',
}: TransactionsTableProps) {
  const columns = React.useMemo<DataTableColumn<FinanceTransactionPublic>[]>(
    () => {
      const cols: DataTableColumn<FinanceTransactionPublic>[] = [
        {
          id: 'date',
          header: 'Date',
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-sm tabular-nums text-muted-foreground">
              {formatDateUtc(row.original.date)}
            </span>
          ),
        },
        {
          id: 'description',
          header: 'Description',
          cell: ({ row }) => {
            const t = row.original;
            const primary =
              t.description ||
              t.party?.name ||
              FINANCE_CATEGORY_META[t.category].label;
            return (
              <div className="min-w-0 max-w-xs">
                <Link
                  href={`/finance/transactions/${t.id}`}
                  className="block truncate text-sm font-medium text-foreground hover:underline"
                >
                  {primary}
                </Link>
                {t.reference ? (
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {t.reference}
                  </div>
                ) : null}
              </div>
            );
          },
        },
        {
          id: 'category',
          header: 'Category',
          cell: ({ row }) => {
            const t = row.original;
            const meta = FINANCE_CATEGORY_META[t.category];
            return (
              <div className="flex flex-col items-start gap-1">
                <StatusBadge
                  status={t.category}
                  tone={directionTone(t.direction)}
                  label={meta.label}
                />
                {meta.kind === 'FINANCING' ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    not P&amp;L
                  </span>
                ) : null}
              </div>
            );
          },
        },
      ];

      if (showParty) {
        cols.push({
          id: 'party',
          header: 'Party',
          cell: ({ row }) => {
            const p = row.original.party;
            const via = row.original.viaParty;
            if (!p && !via) {
              return <span className="text-sm text-muted-foreground">—</span>;
            }
            return (
              <div className="min-w-0">
                {p ? (
                  <Link
                    href={`/finance/parties/${p.id}`}
                    className="block truncate text-sm text-foreground hover:underline"
                  >
                    {p.name}
                  </Link>
                ) : (
                  <span className="block text-sm text-muted-foreground">—</span>
                )}
                {via ? (
                  <Link
                    href={`/finance/parties/${via.id}`}
                    className="block truncate text-[11px] text-status-amber hover:underline"
                    title="Money was routed through this person; it does not count as paid to them"
                  >
                    ↳ via {via.name}
                  </Link>
                ) : null}
              </div>
            );
          },
        });
      }

      cols.push(
        {
          id: 'account',
          header: 'Account',
          cell: ({ row }) => {
            const a = row.original.account;
            const settles = row.original.settlesAccount;
            return (
              <div className="min-w-0">
                <span className="block truncate text-sm text-muted-foreground">
                  {a ? a.name : '—'}
                </span>
                {settles ? (
                  <span className="block truncate text-[11px] text-status-blue">
                    settles {settles.name}
                  </span>
                ) : null}
              </div>
            );
          },
        },
        {
          id: 'amount',
          header: () => <span className="block text-right">Amount</span>,
          cell: ({ row }) => {
            const t = row.original;
            return (
              <div className="text-right">
                <span
                  className={cn(
                    'block whitespace-nowrap text-sm font-semibold tabular-nums',
                    amountClass(t.direction),
                  )}
                >
                  {amountSign(t.direction)}
                  {formatInr(t.amount)}
                </span>
                {t.originalAmount !== null && t.originalCurrency ? (
                  <span className="block text-[11px] tabular-nums text-muted-foreground">
                    {t.originalAmount.toLocaleString('en-IN')} {t.originalCurrency}
                  </span>
                ) : null}
              </div>
            );
          },
        },
        {
          id: 'actions',
          header: () => <span className="sr-only">Actions</span>,
          cell: ({ row }) => (
            <div className="flex justify-end">
              <Button asChild variant="ghost" size="sm">
                <Link href={`/finance/transactions/${row.original.id}`}>Edit</Link>
              </Button>
            </div>
          ),
        },
      );

      return cols;
    },
    [showParty],
  );

  return (
    <DataTable<FinanceTransactionPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Receipt,
        title: 'No transactions',
        description:
          'Nothing matches these filters. Record money in or out to start the ledger.',
        action: (
          <Button asChild size="sm">
            <Link href={newHref}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>New transaction</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
