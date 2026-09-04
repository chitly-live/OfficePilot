'use client';

/**
 * Delete a party. The API refuses (409) while transactions or accounts
 * still point at it — the toast explains what to do instead.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

import { requestJson } from '../finance-ui';

export interface DeletePartyButtonProps {
  partyId: string;
  partyName: string;
}

export function DeletePartyButton({ partyId, partyName }: DeletePartyButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    const result = await requestJson(`/api/finance/parties/${partyId}`, {
      method: 'DELETE',
    });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('delete failed');
    }
    toast.success('Party deleted.');
    router.replace('/finance/parties');
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
        title="Delete party?"
        description={
          <>
            <span className="font-medium text-foreground">{partyName}</span> will be
            removed. Only possible when no transactions or accounts are linked to
            them — otherwise mark them inactive.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}
