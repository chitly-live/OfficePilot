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
import { itcByHead, itcRunningBalances } from '@/lib/gst';
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

/** Tiny IGST / CGST / SGST line under an amount; hidden when unsplit. */
function HeadSplit({ igst, cgst, sgst }: { igst: number; cgst: number; sgst: number }) {
  if (igst === 0 && cgst === 0 && sgst === 0) return null;
  const parts: string[] = [];
  if (igst > 0) parts.push(`I ${formatInr(igst)}`);
  if (cgst > 0) parts.push(`C ${formatInr(cgst)}`);
  if (sgst > 0) parts.push(`S ${formatInr(sgst)}`);
  return (
    <div className="whitespace-nowrap text-[11px] font-normal text-muted-foreground">
      {parts.join(' · ')}
    </div>
  );
}

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

  const totalClaimed = items.reduce((s, r) => s + r.itcClaimed, 0);
  const totalItc = items.reduce((s, r) => s + r.itcUsed, 0);
  const totalCash = items.reduce((s, r) => s + r.cashPaid, 0);
  const balances = itcRunningBalances(items);
  const byHead = itcByHead(items);
  const itcBalance = Math.round((totalClaimed - totalItc) * 100) / 100;
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
        subtitle="One line per tax period: input tax credit claimed, GST paid by ITC, GST paid in cash — and the ITC balance that carries forward."
        actions={<GstDialog mode="create" accounts={accountRows} defaultMonth={suggestedMonth} />}
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="ITC balance (carry forward)"
          value={formatInr(itcBalance)}
          delta={{ direction: 'flat', label: `${formatInr(totalClaimed)} claimed · ${formatInr(totalItc)} used` }}
        />
        <StatCard label="GST paid by ITC (all time)" value={formatInr(totalItc)} />
        <StatCard label="GST paid in cash (all time)" value={formatInr(totalCash)} invertColor />
        <StatCard
          label={`GST paid in ${thisYear}`}
          value={formatInr(fyTotal)}
          delta={{ direction: 'flat', label: `${fyItems.length} month${fyItems.length === 1 ? '' : 's'}` }}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ITC balance by tax head</CardTitle>
          <CardDescription>
            Credit is tracked per head: IGST credit can settle any head, but CGST credit never
            pays an SGST liability and vice versa.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full max-w-xl text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Head</th>
                  <th className="py-2 pr-3 text-right font-medium">Claimed</th>
                  <th className="py-2 pr-3 text-right font-medium">Used</th>
                  <th className="py-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {(
                  [
                    ['IGST', byHead.igst],
                    ['CGST', byHead.cgst],
                    ['SGST', byHead.sgst],
                  ] as const
                ).map(([label, pos]) => (
                  <tr key={label}>
                    <td className="py-2 pr-3 font-medium text-foreground">{label}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                      {formatInr(pos.claimed)}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{formatInr(pos.used)}</td>
                    <td
                      className={
                        pos.balance < 0
                          ? 'py-2 text-right font-semibold tabular-nums text-status-red'
                          : 'py-2 text-right font-semibold tabular-nums'
                      }
                    >
                      {formatInr(pos.balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

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
            ITC claimed only moves the balance. The paid figures write two ledger entries under
            Government (GST): cash against the chosen account, ITC with no account.
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
                    <th className="py-2 pr-3 text-right font-medium">ITC claimed</th>
                    <th className="py-2 pr-3 text-right font-medium">Paid by ITC</th>
                    <th className="py-2 pr-3 text-right font-medium">Paid in cash</th>
                    <th className="py-2 pr-3 text-right font-medium">Total paid</th>
                    <th className="py-2 pr-3 text-right font-medium">ITC balance</th>
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
                      <td className="py-2 pr-3 text-right tabular-nums text-status-green">
                        {r.itcClaimed > 0 ? `+${formatInr(r.itcClaimed)}` : '—'}
                        <HeadSplit igst={r.itcClaimedIgst} cgst={r.itcClaimedCgst} sgst={r.itcClaimedSgst} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatInr(r.itcUsed)}
                        <HeadSplit igst={r.itcUsedIgst} cgst={r.itcUsedCgst} sgst={r.itcUsedSgst} />
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-status-red">
                        {formatInr(r.cashPaid)}
                        <HeadSplit igst={r.cashPaidIgst} cgst={r.cashPaidCgst} sgst={r.cashPaidSgst} />
                      </td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums">
                        {formatInr(r.itcUsed + r.cashPaid)}
                      </td>
                      <td
                        className={
                          (balances.get(r.month) ?? 0) < 0
                            ? 'py-2 pr-3 text-right tabular-nums text-status-red'
                            : 'py-2 pr-3 text-right tabular-nums'
                        }
                      >
                        {formatInr(balances.get(r.month) ?? 0)}
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
