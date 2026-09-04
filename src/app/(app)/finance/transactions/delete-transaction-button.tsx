'use client';

/**
 * Delete button + confirm dialog for one ledger row. Hard delete; the
 * activity log keeps a record of what was removed.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

import { requestJson } from '../finance-ui';

export interface DeleteTransactionButtonProps {
  transactionId: string;
  label: string;
  returnTo?: string;
}

export function DeleteTransactionButton({
  transactionId,
  label,
  returnTo = '/finance/transactions',
}: DeleteTransactionButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    const result = await requestJson(`/api/finance/transactions/${transactionId}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('delete failed');
    }
    toast.success('Transaction deleted.');
    router.replace(returnTo);
    router.refresh();
  }

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        <span>Delete</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete transaction?"
        description={
          <>
            <span className="font-medium text-foreground">{label}</span> will be
            removed from the ledger. Balances update immediately. This cannot be
            undone.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}
