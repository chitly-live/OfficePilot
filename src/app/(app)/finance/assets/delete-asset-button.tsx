'use client';

/**
 * Delete an asset added by mistake. The payment it was linked to stays in
 * the ledger — only the register entry and its hand-over trail go.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

import { requestJson } from '../finance-ui';

export function DeleteAssetButton({ assetId, name }: { assetId: string; name: string }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    const result = await requestJson(`/api/finance/assets/${assetId}`, { method: 'DELETE' });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('delete failed');
    }
    toast.success('Asset deleted.');
    router.replace('/finance/assets');
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="destructive" size="sm" onClick={() => setOpen(true)}>
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        <span>Delete</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete asset?"
        description={
          <>
            <span className="font-medium text-foreground">{name}</span> and its hand-over history will be
            removed. The payment stays in the ledger. If it was sold or thrown away, change its status
            instead so the record is kept.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}
