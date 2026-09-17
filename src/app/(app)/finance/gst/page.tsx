/**
 * `/finance/gst` — monthly GST returns: how much was set off against
 * input tax credit and how much was paid in cash. ADMIN and ACCOUNTANT can
 * add / edit a month (the accountant's only write); only ADMIN can delete.
 */

import { redirect } from 'next/navigation';
import { ReceiptText } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatDateUtc, formatInr, monthLabel, shiftMonthKey, toMonthKey } from '@/lib/finance';
import { canManageFinance, canViewFinance } from '@/lib/permissions';
import { gstReturnProjection, type GstReturnPublic } from '@/lib/schemas/gst';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';

import { FinanceNav } from '../finance-nav';
import { DeleteGstButton } from './delete-gst-button';
import { GstDialog } from './gst-dialog';

export const metadata = {
  title: 'GST · Finance',
};

export const dynamic = 'force-dynamic';

export default async function GstPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance/gst');
  }
  if (!canViewFinance(session.role)) {
    redirect('/dashboard');
  }
  const isAdmin = canManageFinance(session.role);

  const [rows, accountRows] = await Promise.all([
    prisma.gstReturn.findMany({ select: gstReturnProjection, orderBy: [{ month: 'desc' }] }),
    prisma.financeAccount.findMany({
      where: { isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
    }),
  ]);
  const items = rows as unknown as GstReturnPublic[];

  const totalItc = items.reduce((s, r) => s + r.itcUsed, 0);
  const totalCash = items.reduce((s, r) => s + r.cashPaid, 0);
  const thisYear = new Date().getUTCFullYear();
  const fyItems = items.filter((r) => Number(r.month.slice(0, 4)) === thisYear);
  const fyTotal = fyItems.reduce((s, r) => s + r.itcUsed + r.cashPaid, 0);

  // Default the "Add month" dialog to the previous month — the one whose
  // return is due now.
  const suggestedMonth = shiftMonthKey(toMonthKey(new Date()), -1);
  const missingSuggested = !items.some((r) => r.month === suggestedMonth);

  return (
    <div className="space-y-6">
      <PageHeader
        title="GST"
        subtitle="One line per tax period: what was set off against input tax credit and what was paid in cash."
        actions={<GstDialog mode="create" accounts={accountRows} defaultMonth={suggestedMonth} />}
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="ITC used (all time)" value={formatInr(totalItc)} />
        <StatCard label="Cash paid (all time)" value={formatInr(totalCash)} invertColor />
        <StatCard
          label={`GST paid in ${thisYear}`}
          value={formatInr(fyTotal)}
          delta={{ direction: 'flat', label: `${fyItems.length} month${fyItems.length === 1 ? '' : 's'}` }}
        />
      </div>

      {missingSuggested ? (
        <div className="rounded-md border border-status-amber/40 bg-status-amber/5 px-3 py-2 text-sm">
          The return for <span className="font-medium">{monthLabel(suggestedMonth)}</span> has not
          been recorded yet. Use <span className="font-medium">Add month</span> once it is filed.
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Returns</CardTitle>
          <CardDescription>
            Each row writes two entries to the ledger under Government (GST): the cash part
            against the chosen account, the ITC part with no account (no cash moved).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={ReceiptText}
              title="No GST returns yet"
              description="Add the first month once the return is filed."
              action={<GstDialog mode="create" accounts={accountRows} defaultMonth={suggestedMonth} />}
              className="py-8"
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Period</th>
                    <th className="py-2 pr-3 text-right font-medium">ITC used</th>
                    <th className="py-2 pr-3 text-right font-medium">Cash paid</th>
                    <th className="py-2 pr-3 text-right font-medium">Total</th>
                    <th className="py-2 pr-3 font-medium">Paid on</th>
                    <th className="py-2 pr-3 font-medium">Cash from</th>
                    <th className="py-2 pr-3 font-medium">Reference</th>
                    <th className="py-2 pr-3 font-medium">By</th>
                    <th className="py-2 text-right font-medium">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td className="py-2 pr-3 font-medium text-foreground">{monthLabel(r.month)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{formatInr(r.itcUsed)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-status-red">
                        {formatInr(r.cashPaid)}
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                        {formatInr(r.itcUsed + r.cashPaid)}
                      </td>
                      <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                        {r.paidOn ? formatDateUtc(r.paidOn) : '—'}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {r.cashPaid > 0 ? (
                          r.cashAccount ? (
                            r.cashAccount.name
                          ) : (
                            <span className="text-status-amber">not set</span>
                          )
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                        {r.reference ?? '—'}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{r.createdBy.name ?? '—'}</td>
                      <td className="py-2 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <GstDialog mode="edit" gstReturn={r} accounts={accountRows} />
                          {isAdmin ? <DeleteGstButton id={r.id} label={monthLabel(r.month)} /> : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
