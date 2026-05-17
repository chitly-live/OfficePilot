'use client';

/**
 * LeadDeleteButton — admin-only "delete this lead" affordance.
 *
 * Wraps `ConfirmDialog` so the destructive action requires explicit
 * confirmation. On confirm, calls `DELETE /api/leads/[id]` (hard
 * delete per SPEC §6.3). On success → redirect to `/leads`.
 *
 * The parent page only renders this for ADMIN sessions; the API
 * enforces the same gate via `requireAdminSession()`.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadDeleteButtonProps {
  leadId: string;
  leadName?: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'Only administrators can delete leads.';
  if (status === 404) return 'Lead not found.';
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function LeadDeleteButton({ leadId, leadName }: LeadDeleteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    let res: Response;
    try {
      res = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
    } catch {
      toast.error('Network error. Please try again.');
      throw new Error('network');
    }

    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      toast.error(describeError(body, res.status));
      throw new Error('api');
    }

    toast.success('Lead deleted.');
    // Hard navigation back to the list — `/leads/[id]` no longer exists.
    router.replace('/leads');
    router.refresh();
  }

  const target = leadName?.trim() || 'this lead';

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
        title="Delete lead?"
        description={
          <>
            <span className="font-medium text-foreground">{target}</span> will
            be permanently removed. Existing notes and activity records are
            preserved for audit, but the lead row itself cannot be recovered.
          </>
        }
        confirmLabel="Delete"
        onConfirm={handleConfirm}
      />
    </>
  );
}
