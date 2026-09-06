'use client';

/**
 * "Record salary payment" — makes sure the employee has a Finance party
 * (`POST /api/users/[id]/finance-party`), then opens the Money-out form
 * pre-filled with category SALARY and that party.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Banknote, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export interface RecordSalaryButtonProps {
  userId: string;
  /** Prefilled amount (the agreed monthly pay), if any. */
  amount?: number | null;
  /** e.g. "Intern stipend — August 2026" */
  description?: string;
  returnTo?: string;
  variant?: 'default' | 'outline';
  size?: 'sm' | 'default';
  label?: string;
}

export function RecordSalaryButton({
  userId,
  amount,
  description,
  returnTo,
  variant = 'default',
  size = 'sm',
  label = 'Record salary payment',
}: RecordSalaryButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  async function go() {
    setBusy(true);
    try {
      const res = await fetch(`/api/users/${userId}/finance-party`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Could not prepare the salary entry.');
        return;
      }
      const party = (await res.json()) as { id: string };
      const params = new URLSearchParams({
        direction: 'OUT',
        category: 'SALARY',
        partyId: party.id,
      });
      if (amount && amount > 0) params.set('amount', String(amount));
      if (description) params.set('description', description);
      if (returnTo) params.set('returnTo', returnTo);
      router.push(`/finance/transactions/new?${params.toString()}`);
    } catch {
      toast.error('Could not prepare the salary entry.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button type="button" variant={variant} size={size} onClick={go} disabled={busy}>
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Banknote className="h-4 w-4" aria-hidden="true" />
      )}
      <span>{label}</span>
    </Button>
  );
}
