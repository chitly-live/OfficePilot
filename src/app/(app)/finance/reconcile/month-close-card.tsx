'use client';

/**
 * Closed months: when each was locked, the balances recorded then, and a
 * loud warning if any balance has moved since. Admins close the next month
 * or reopen the latest one.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Lock, LockOpen, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatInr, monthLabel } from '@/lib/finance';

import { requestJson } from '../finance-ui';

export interface MonthCloseRow {
  month: string;
  closedAt: string;
  closedBy: string;
  note: string | null;
  balances: { accountId: string; accountName: string; balance: number }[];
  drift: { accountId: string; accountName: string; recorded: number; now: number; difference: number }[];
}

export interface MonthCloseCardProps {
  closes: MonthCloseRow[];
  lockedThrough: string | null;
  suggested: string;
  canEdit: boolean;
}

export function MonthCloseCard({ closes, lockedThrough, suggested, canEdit }: MonthCloseCardProps) {
  const router = useRouter();
  const [month, setMonth] = React.useState(suggested);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [reopenOpen, setReopenOpen] = React.useState(false);

  const drifted = closes.filter((c) => c.drift.length > 0);

  async function close() {
    setBusy(true);
    const result = await requestJson<{ closed: string[] }>('/api/finance/close', {
      method: 'POST',
      json: { month, ...(note.trim() ? { note: note.trim() } : {}) },
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(`Closed ${result.data.closed.map(monthLabel).join(', ')}.`);
    setNote('');
    router.refresh();
  }

  async function reopen() {
    if (!lockedThrough) return;
    const result = await requestJson(`/api/finance/close?month=${lockedThrough}`, { method: 'DELETE' });
    if (!result.ok) {
      toast.error(result.message);
      throw new Error('reopen failed');
    }
    toast.success(`${monthLabel(lockedThrough)} reopened.`);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Lock className="h-4 w-4" aria-hidden="true" />
          Closed months
        </CardTitle>
        <CardDescription>
          {lockedThrough
            ? `Books are locked up to the end of ${monthLabel(lockedThrough)}. Nothing dated on or before then can be added, changed or deleted.`
            : 'No month is closed yet. Close a month once its bank statement matches, so the checked figures cannot move.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {drifted.length > 0 ? (
          <div className="rounded-md border border-status-red/40 bg-status-red/5 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-status-red">
              <TriangleAlert className="h-4 w-4" aria-hidden="true" />
              A closed balance has changed since it was locked
            </p>
            <ul className="mt-2 space-y-1 text-muted-foreground">
              {drifted.flatMap((c) =>
                c.drift.map((d) => (
                  <li key={`${c.month}-${d.accountId}`}>
                    {monthLabel(c.month)} · {d.accountName}: closed at {formatInr(d.recorded)}, now {formatInr(d.now)} (
                    {d.difference > 0 ? '+' : ''}
                    {formatInr(d.difference)})
                  </li>
                )),
              )}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              The lock stops changes through the panel, so this came from outside it. Find the row, then reopen and
              close the month again to record the correct figure.
            </p>
          </div>
        ) : null}

        {closes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Month</th>
                  <th className="py-2 pr-3 font-medium">Balances at close</th>
                  <th className="py-2 pr-3 font-medium">Closed</th>
                  <th className="py-2 font-medium">Check</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {closes.map((c) => (
                  <tr key={c.month} className="align-top">
                    <td className="py-2 pr-3 font-medium whitespace-nowrap">{monthLabel(c.month)}</td>
                    <td className="py-2 pr-3">
                      <ul className="space-y-0.5 text-xs">
                        {c.balances
                          .filter((b) => Math.abs(b.balance) >= 0.01)
                          .map((b) => (
                            <li key={b.accountId} className="flex justify-between gap-4">
                              <span className="text-muted-foreground">{b.accountName}</span>
                              <span className="tabular-nums">{formatInr(b.balance)}</span>
                            </li>
                          ))}
                      </ul>
                    </td>
                    <td className="py-2 pr-3 text-xs text-muted-foreground">
                      {new Date(c.closedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}{' '}
                      by {c.closedBy}
                      {c.note ? <span className="block">{c.note}</span> : null}
                    </td>
                    <td className="py-2 text-xs">
                      {c.drift.length === 0 ? (
                        <span className="text-status-green">Unchanged</span>
                      ) : (
                        <span className="font-medium text-status-red">Changed</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {canEdit ? (
          <div className="flex flex-col gap-3 rounded-md border p-3 sm:flex-row sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="close-month" className="text-xs">
                Close up to
              </Label>
              <Input
                id="close-month"
                type="month"
                value={month}
                max={suggested}
                onChange={(e) => setMonth(e.target.value)}
                className="w-44"
                disabled={busy}
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="close-note" className="text-xs">
                Note <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="close-note"
                placeholder="Matched with YES BANK statement, closing ₹44,284.99"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                disabled={busy}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" onClick={close} disabled={busy || !month}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Lock className="h-4 w-4" aria-hidden="true" />}
                <span>Close</span>
              </Button>
              {lockedThrough ? (
                <Button type="button" variant="outline" onClick={() => setReopenOpen(true)} disabled={busy}>
                  <LockOpen className="h-4 w-4" aria-hidden="true" />
                  <span>Reopen {monthLabel(lockedThrough)}</span>
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        {lockedThrough ? (
          <ConfirmDialog
            open={reopenOpen}
            onOpenChange={setReopenOpen}
            title={`Reopen ${monthLabel(lockedThrough)}?`}
            description="Entries dated in that month can be changed again. Close it again once you have made the correction."
            confirmLabel="Reopen"
            confirmVariant="default"
            onConfirm={reopen}
          />
        ) : null}
      </CardContent>
    </Card>
  );
}
