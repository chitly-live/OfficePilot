/**
 * `/finance/dues` — the money position (cash against what we owe) and every
 * payment coming up: card bills already generated, GST, salaries, renewals,
 * the bank's average balance, loans. Overdue first.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';
import { canViewFinance } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { DUE_KIND_LABELS, loadDues, loadPosition, type DueItem, type DueStatus } from '@/lib/dues';
import { formatDateUtc, formatInr, monthLabel } from '@/lib/finance';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { FinanceNav } from '../finance-nav';

export const metadata = { title: 'Dues · Finance' };
export const dynamic = 'force-dynamic';

const STATUS_META: Record<DueStatus, { label: string; tone: 'red' | 'amber' | 'blue' | 'green' }> = {
  OVERDUE: { label: 'Overdue', tone: 'red' },
  DUE_SOON: { label: 'Due this week', tone: 'amber' },
  UPCOMING: { label: 'Later', tone: 'blue' },
  DONE: { label: 'Done', tone: 'green' },
};

function daysFrom(today: Date, d: Date | null): string {
  if (!d) return '';
  const a = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((d.getTime() - a) / (24 * 60 * 60 * 1000));
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

export default async function DuesPage() {
  const session = await auth();
  if (!session?.userId) redirect('/login?callbackUrl=/finance/dues');
  if (!canViewFinance(session.role)) redirect('/dashboard');

  const today = new Date();
  const [dues, position] = await Promise.all([loadDues(prisma, today), loadPosition(prisma, today)]);

  const open = dues.filter((d) => d.status !== 'DONE');
  const toPay = open.reduce((s, d) => s + (d.kind === 'AMB' ? 0 : (d.amount ?? 0)), 0);
  const groups = (['OVERDUE', 'DUE_SOON', 'UPCOMING', 'DONE'] as const)
    .map((status) => ({ status, items: dues.filter((d) => d.status === status) }))
    .filter((g) => g.items.length > 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Dues" subtitle="What we hold, what we owe, and every payment coming up — overdue first." />

      <FinanceNav />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Cash in our accounts</CardDescription>
            <CardTitle className="text-2xl tabular-nums">{formatInr(position.cash)}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-0.5 text-sm">
              {position.cashAccounts.map((a) => (
                <li key={a.id} className="flex justify-between gap-4">
                  <span className="text-muted-foreground">{a.name}</span>
                  <span className="tabular-nums">{formatInr(a.balance)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>We owe</CardDescription>
            <CardTitle className="text-2xl tabular-nums text-status-red">{formatInr(position.owed)}</CardTitle>
          </CardHeader>
          <CardContent>
            {position.owedTo.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing owed to anyone.</p>
            ) : (
              <ul className="space-y-0.5 text-sm">
                {position.owedTo.map((p) => (
                  <li key={p.partyId} className="flex justify-between gap-4">
                    <Link href={p.href} className="text-muted-foreground hover:underline">
                      {p.name}
                    </Link>
                    <span className="tabular-nums">{formatInr(p.owed)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card className={cn(position.net < 0 ? 'border-status-red/40' : 'border-status-green/40')}>
          <CardHeader className="pb-2">
            <CardDescription>Net position (cash − owed)</CardDescription>
            <CardTitle
              className={cn('text-2xl tabular-nums', position.net < 0 ? 'text-status-red' : 'text-status-green')}
            >
              {formatInr(position.net)}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {position.net < 0
                ? 'We owe more than we hold today. Upcoming settlements have to cover the gap.'
                : 'Everything we owe could be paid from the accounts today.'}
            </p>
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">Open dues below: </span>
              <span className="font-medium tabular-nums">{formatInr(toPay)}</span>
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operating result by month</CardTitle>
          <CardDescription>
            Income minus expense (card repayments, loans and asset purchases excluded — they are not profit or loss).
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Month</th>
                <th className="py-2 pr-3 text-right font-medium">Income</th>
                <th className="py-2 pr-3 text-right font-medium">Expense</th>
                <th className="py-2 text-right font-medium">Result</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {position.months.map((m) => (
                <tr key={m.month}>
                  <td className="py-2 pr-3">
                    {monthLabel(m.month)}
                    {m.complete ? null : <span className="ml-1 text-xs text-muted-foreground">(so far)</span>}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-status-green">{formatInr(m.income)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-status-red">{formatInr(m.expense)}</td>
                  <td
                    className={cn(
                      'py-2 text-right font-medium tabular-nums',
                      m.net < 0 ? 'text-status-red' : 'text-status-green',
                    )}
                  >
                    {formatInr(m.net)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {groups.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Nothing due.</p>
      ) : (
        groups.map((g) => (
          <Card key={g.status}>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <StatusBadge status={g.status} tone={STATUS_META[g.status].tone} label={STATUS_META[g.status].label} />
                <span className="text-sm font-normal text-muted-foreground">{g.items.length}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody className="divide-y">
                  {g.items.map((d) => (
                    <DueRow key={d.key} item={d} today={today} />
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}

function DueRow({ item, today }: { item: DueItem; today: Date }) {
  const title = item.href ? (
    <Link href={item.href} className="font-medium text-foreground hover:underline">
      {item.title}
    </Link>
  ) : (
    <span className="font-medium text-foreground">{item.title}</span>
  );
  return (
    <tr className="align-top">
      <td className="w-28 py-2 pr-3 text-xs uppercase tracking-wide text-muted-foreground">
        {DUE_KIND_LABELS[item.kind]}
      </td>
      <td className="py-2 pr-3">
        {title}
        <span className="block text-xs text-muted-foreground">{item.detail}</span>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {item.dueDate ? formatDateUtc(item.dueDate) : '—'}
        {item.status !== 'DONE' && item.dueDate ? (
          <span
            className={cn(
              'block text-xs',
              item.status === 'OVERDUE' ? 'text-status-red' : item.status === 'DUE_SOON' ? 'text-status-amber' : 'text-muted-foreground',
            )}
          >
            {daysFrom(today, item.dueDate)}
          </span>
        ) : null}
      </td>
      <td className="py-2 text-right whitespace-nowrap">
        {item.status === 'DONE' ? (
          <span className="text-status-green">{item.doneLabel ?? 'Done'}</span>
        ) : item.amount === null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="font-semibold tabular-nums">
            {item.kind === 'AMB' ? `${formatInr(item.amount)}/day` : formatInr(item.amount)}
          </span>
        )}
      </td>
    </tr>
  );
}
