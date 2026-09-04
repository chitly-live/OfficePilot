'use client';

/**
 * Parties table with the all-time "we owe" balance per row.
 */

import * as React from 'react';
import Link from 'next/link';
import { Users } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import {
  FINANCE_PARTY_TYPE_SHORT,
  formatInr,
  type PartyBalance,
} from '@/lib/finance';
import type { FinancePartyPublic } from '@/lib/schemas/finance';
import { cn } from '@/lib/utils';

import { PARTY_TYPE_TONE } from '../finance-ui';

export type PartyRow = FinancePartyPublic & { balance: PartyBalance | null };

export interface PartiesTableProps {
  items: PartyRow[];
  emptyAction?: React.ReactNode;
}

export function PartiesTable({ items, emptyAction }: PartiesTableProps) {
  const columns = React.useMemo<DataTableColumn<PartyRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Party',
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="min-w-0">
              <Link
                href={`/finance/parties/${p.id}`}
                className="block truncate text-sm font-medium text-foreground hover:underline"
              >
                {p.name}
              </Link>
              {p.phone || p.email ? (
                <div className="truncate text-xs text-muted-foreground">
                  {[p.phone, p.email].filter(Boolean).join(' · ')}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <StatusBadge
            status={row.original.type}
            tone={PARTY_TYPE_TONE[row.original.type]}
            label={FINANCE_PARTY_TYPE_SHORT[row.original.type]}
          />
        ),
      },
      {
        id: 'owed',
        header: () => <span className="block text-right">We owe</span>,
        cell: ({ row }) => {
          const b = row.original.balance;
          if (!b || b.owed === 0) {
            return <span className="block text-right text-sm text-muted-foreground">—</span>;
          }
          return (
            <div className="text-right">
              <span
                className={cn(
                  'block text-sm font-semibold tabular-nums',
                  b.owed > 0 ? 'text-status-red' : 'text-status-green',
                )}
              >
                {b.owed > 0 ? formatInr(b.owed) : `${formatInr(-b.owed)} extra`}
              </span>
              <span className="block text-[11px] text-muted-foreground">
                {b.loanOutstanding !== 0 ? `loan ${formatInr(b.loanOutstanding)}` : ''}
                {b.loanOutstanding !== 0 && b.cardOutstanding !== 0 ? ' · ' : ''}
                {b.cardOutstanding !== 0 ? `card ${formatInr(b.cardOutstanding)}` : ''}
              </span>
            </div>
          );
        },
      },
      {
        id: 'paidTo',
        header: () => <span className="block text-right">Paid to them</span>,
        cell: ({ row }) => (
          <span className="block text-right text-sm tabular-nums text-foreground">
            {row.original.balance ? formatInr(row.original.balance.paidTo) : '—'}
          </span>
        ),
      },
      {
        id: 'receivedFrom',
        header: () => <span className="block text-right">Received</span>,
        cell: ({ row }) => (
          <span className="block text-right text-sm tabular-nums text-foreground">
            {row.original.balance ? formatInr(row.original.balance.receivedFrom) : '—'}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge status="ACTIVE" tone="green" label="Active" />
          ) : (
            <StatusBadge status="INACTIVE" tone="neutral" label="Inactive" />
          ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/finance/parties/${row.original.id}`}>View</Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<PartyRow>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Users,
        title: 'No parties yet',
        description:
          'Add the people and companies money moves between: financers, card owners, hosts, vendors.',
        action: emptyAction,
      }}
    />
  );
}
