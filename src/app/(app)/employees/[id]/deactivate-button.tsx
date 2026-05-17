'use client';

/**
 * DeactivateButton — admin-only "deactivate this employee" affordance.
 *
 * Wraps `ConfirmDialog` so the destructive action requires explicit
 * confirmation. On confirm, calls `DELETE /api/users/[id]` (which the
 * API treats as a soft delete: `isActive=false`). On success →
 * `router.refresh()` so the parent page reflects the new state
 * (status badge flips, this button hides per the parent's
 * `employee.isActive` check).
 *
 * The parent (`/employees/[id]/page.tsx`) handles the visibility
 * gate (admin && !self && active); this component just owns the
 * confirmation UX.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { UserMinus } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeactivateButtonProps {
  userId: string;
  /** Friendly name for the confirmation copy. Falls back to "this user". */
  userName?: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'Only administrators can deactivate users.';
  if (status === 404) return 'User not found.';
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function DeactivateButton({ userId, userName }: DeactivateButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  async function handleConfirm() {
    let res: Response;
    try {
      res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });
    } catch {
      toast.error('Network error. Please try again.');
      // Re-throw so `ConfirmDialog` keeps itself open for retry.
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

    toast.success('Employee deactivated.');
    router.refresh();
  }

  const target = userName?.trim() || 'this user';

  return (
    <>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <UserMinus className="h-4 w-4" aria-hidden="true" />
        <span>Deactivate</span>
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Deactivate employee?"
        description={
          <>
            <span className="font-medium text-foreground">{target}</span>{' '}
            will no longer be able to sign in. Their records (leads,
            campaigns, history) stay intact and can be reassigned. You
            can reactivate the account later from the profile.
          </>
        }
        confirmLabel="Deactivate"
        onConfirm={handleConfirm}
      />
    </>
  );
}
