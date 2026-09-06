'use client';

/**
 * Admin-only inline form to set an employee's agreed monthly pay
 * (`monthlySalary` + `salaryLabel`). Saves via `PATCH /api/users/[id]`.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface SalaryFormProps {
  userId: string;
  monthlySalary: number | null;
  salaryLabel: string | null;
}

export function SalaryForm({ userId, monthlySalary, salaryLabel }: SalaryFormProps) {
  const router = useRouter();
  const [amount, setAmount] = React.useState(monthlySalary !== null ? String(monthlySalary) : '');
  const [label, setLabel] = React.useState(salaryLabel ?? '');
  const [saving, setSaving] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = amount.trim();
    const value = trimmed === '' ? null : Number(trimmed);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      toast.error('Enter a valid amount');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          monthlySalary: value,
          salaryLabel: label.trim() === '' ? null : label.trim(),
        }),
      });
      if (!res.ok) {
        let message = 'Could not save salary.';
        try {
          const body = (await res.json()) as { message?: string };
          if (body.message) message = body.message;
        } catch {
          // keep generic
        }
        toast.error(message);
        return;
      }
      toast.success(value === null ? 'Salary cleared.' : 'Salary saved.');
      router.refresh();
    } catch {
      toast.error('Could not save salary.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <div className="space-y-1.5">
        <Label htmlFor="salary-amount">Monthly amount (₹)</Label>
        <Input
          id="salary-amount"
          type="number"
          inputMode="decimal"
          min={0}
          step="any"
          placeholder="5000"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          disabled={saving}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="salary-label">Label</Label>
        <Input
          id="salary-label"
          placeholder="Intern stipend / Salary"
          maxLength={60}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={saving}
        />
      </div>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
        <span>Save</span>
      </Button>
    </form>
  );
}
