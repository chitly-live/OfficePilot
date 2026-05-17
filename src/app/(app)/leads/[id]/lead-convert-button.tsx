'use client';

/**
 * LeadConvertButton — single-click "convert" affordance.
 *
 * Sends `PATCH /api/leads/[id]` with `{ status: 'CONVERTED' }`. The
 * route auto-stamps `convertedAt = now` on the first transition into
 * CONVERTED and emits both `lead.status_changed` and `lead.converted`
 * activity rows (see `src/app/api/leads/[id]/route.ts`).
 *
 * Wrapped in a `ConfirmDialog` because conversion is a meaningful
 * business event — we want the user to confirm rather than have a
 * mis-click flip the funnel state.
 *
 * Authorisation:
 *   • The API enforces "ADMIN or owner/creator". The parent page
 *     hides this button when the current user can't edit, but a
 *     defensive 403 toast is still surfaced if the API rejects.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadConvertButtonProps {
  leadId: string;
  /** Friendly name for the confirmation copy. */
  leadName?: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to convert this lead.';
  if (status === 404) return 'Lead not found.';
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function LeadConvertButton({ leadId, leadName }: LeadConvertButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    let res: Response;
    try {
      res = await fetch(`/api/leads/${leadId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'CONVERTED' }),
      });
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

    toast.success('Lead converted.');
    router.refresh();
  }

  const target = leadName?.trim() || 'this lead';

  return (
    <>
      <Button
        type="button"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
        <span>Convert</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Mark as converted?"
        description={
          <>
            <span className="font-medium text-foreground">{target}</span> will
            move to the <strong>Converted</strong> stage and the conversion
            timestamp will be stamped now. You can move it back later if
            needed.
          </>
        }
        confirmLabel="Mark converted"
        confirmVariant="default"
        onConfirm={handleConfirm}
      />
    </>
  );
}
