'use client';

/**
 * Accounts table with all-time balance, inline edit dialog and delete.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Landmark, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { FINANCE_ACCOUNT_TYPE_LABELS, formatInr } from '@/lib/finance';
import type { FinanceAccountPublic } from '@/lib/schemas/finance';
import { cn } from '@/lib/utils';

import { requestJson } from '../finance-ui';
import { AccountDialog, type AccountDialogPartyOption } from './account-dialog';

export type AccountRow = FinanceAccountPublic & { balance: number };

export interface AccountsTableProps {
  items: AccountRow[];
  parties: AccountDialogPartyOption[];
  emptyAction?: React.ReactNode;
}

function DeleteAccountCell({ account }: { account: AccountRow }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    const result = await requestJson(`/api/finance/accounts/${account.id}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('delete failed');
    }
    toast.success('Account deleted.');
    router.refresh();
  }

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={`Delete ${account.name}`}
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete account?"
        description={
          <>
            <span className="font-medium text-foreground">{account.name}</span> will be
            removed. Only possible when no transactions use it — otherwise mark it
            inactive.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}

export function AccountsTable({ items, parties, emptyAction }: AccountsTableProps) {
  const columns = React.useMemo<DataTableColumn<AccountRow>[]>(
    () => [
      {
        id: 'name',
        header: 'Account',
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-foreground">
              {row.original.name}
            </div>
            {row.original.notes ? (
              <div className="truncate text-xs text-muted-foreground">
                {row.original.notes}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        id: 'type',
        header: 'Type',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {FINANCE_ACCOUNT_TYPE_LABELS[row.original.type]}
          </span>
        ),
      },
      {
        id: 'owner',
        header: 'Belongs to',
        cell: ({ row }) => {
          const owner = row.original.ownerParty;
          if (!owner) {
            return <span className="text-sm text-muted-foreground">Company</span>;
          }
          return (
            <Link
              href={`/finance/parties/${owner.id}`}
              className="text-sm text-foreground hover:underline"
            >
              {owner.name}
            </Link>
          );
        },
      },
      {
        id: 'opening',
        header: () => <span className="block text-right">Opening</span>,
        cell: ({ row }) => (
          <span className="block text-right text-sm tabular-nums text-muted-foreground">
            {formatInr(row.original.openingBalance)}
          </span>
        ),
      },
      {
        id: 'balance',
        header: () => <span className="block text-right">Balance</span>,
        cell: ({ row }) => (
          <span
            className={cn(
              'block text-right text-sm font-semibold tabular-nums',
              row.original.balance < 0 ? 'text-status-red' : 'text-foreground',
            )}
          >
            {formatInr(row.original.balance)}
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
          <div className="flex items-center justify-end gap-1">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/finance/transactions?month=all&accountId=${row.original.id}`}>
                Ledger
              </Link>
            </Button>
            <AccountDialog
              mode="edit"
              account={{
                id: row.original.id,
                name: row.original.name,
                type: row.original.type,
                ownerPartyId: row.original.ownerPartyId,
                openingBalance: row.original.openingBalance,
                notes: row.original.notes,
                isActive: row.original.isActive,
              }}
              parties={parties}
            />
            <DeleteAccountCell account={row.original} />
          </div>
        ),
      },
    ],
    [parties],
  );

  return (
    <DataTable<AccountRow>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Landmark,
        title: 'No accounts yet',
        description:
          'Add your bank account, cash box, UPI and any credit cards borrowed from others.',
        action: emptyAction,
      }}
    />
  );
}
