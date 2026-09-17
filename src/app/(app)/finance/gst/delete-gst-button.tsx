'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

import { requestJson } from '../finance-ui';

export function DeleteGstButton({ id, label }: { id: string; label: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    const result = await requestJson(`/api/finance/gst/${id}`, { method: 'DELETE' });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('delete failed');
    }
    toast.success('GST return deleted.');
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`Delete ${label}`}>
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete GST return?"
        description={
          <>
            The return for <span className="font-medium text-foreground">{label}</span> and
            both of its ledger rows (cash and ITC) will be removed.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}
