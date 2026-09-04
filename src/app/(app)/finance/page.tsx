/**
 * `/finance` — monthly overview: income, expense, net, category
 * breakdown, "kitna dena hai" (outstanding to financers / card owners),
 * account balances, 6-month trend and the latest ledger rows.
 *
 * Admin-only (middleware + the redirect below). `?month=YYYY-MM` picks
 * the window; defaults to the current UTC month.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Landmark,
  Receipt,
  Users,
  Wallet,
} from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  FINANCE_PARTY_TYPE_SHORT,
  FINANCE_ACCOUNT_TYPE_LABELS,
  categoryLabel,
  formatDateUtc,
  formatInr,
  monthLabel,
  monthRange,
  shiftMonthKey,
  toMonthKey,
} from '@/lib/finance';
import { loadFinanceSummary } from '@/lib/finance-summary';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { FinanceNav } from './finance-nav';
import { FinanceTrendChart } from './finance-trend-chart';
import { PARTY_TYPE_TONE, amountClass, amountSign } from './finance-ui';

export const metadata = {
  title: 'Finance',
};

export const dynamic = 'force-dynamic';

const MONTH_KEY_RE = /^\d{4}-\d{2}$/;

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw === '' ? undefined : raw;
}

interface FinancePageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function FinancePage({ searchParams }: FinancePageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const rawMonth = coerceParam(searchParams?.month);
  const monthKey =
    rawMonth && MONTH_KEY_RE.test(rawMonth) && monthRange(rawMonth)
      ? rawMonth
      : toMonthKey(new Date());
  const range = monthRange(monthKey)!;

  const summary = await loadFinanceSummary(prisma, range);
  const { totals } = summary;

  const prevKey = shiftMonthKey(monthKey, -1);
  const nextKey = shiftMonthKey(monthKey, 1);
  const thisMonthKey = toMonthKey(new Date());
  const isCurrentMonth = monthKey === thisMonthKey;

  const maxExpense = summary.expenseByCategory[0]?.amount ?? 0;
  const totalOwed = summary.outstanding.reduce((s, o) => s + Math.max(0, o.owed), 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Finance"
        subtitle="Income, expenses, and who we still owe — one ledger for the office."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={`/finance/transactions/new?direction=IN&month=${monthKey}`}>
                <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />
                <span>Money in</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`/finance/transactions/new?direction=OUT&month=${monthKey}`}>
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                <span>Money out</span>
              </Link>
            </Button>
          </div>
        }
      />

      <FinanceNav />

      {/* Month switcher */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1">
          <Button asChild variant="outline" size="sm" aria-label="Previous month">
            <Link href={`/finance?month=${prevKey}`}>
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold text-foreground">
            {monthLabel(monthKey)}
          </span>
          <Button asChild variant="outline" size="sm" aria-label="Next month">
            <Link href={`/finance?month=${nextKey}`}>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </Button>
          {!isCurrentMonth ? (
            <Button asChild variant="ghost" size="sm">
              <Link href="/finance">This month</Link>
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {summary.transactionCount} transaction
          {summary.transactionCount === 1 ? '' : 's'} ·{' '}
          <Link
            href={`/finance/transactions?month=${monthKey}`}
            className="font-medium text-primary hover:underline"
          >
            View ledger →
          </Link>
        </p>
      </div>

      {/* KPI row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Income" value={formatInr(totals.income)} />
        <StatCard
          label="Expense"
          value={formatInr(totals.expense)}
          invertColor
        />
        <StatCard
          label="Net (income − expense)"
          value={
            <span
              className={cn(
                totals.net > 0
                  ? 'text-status-green'
                  : totals.net < 0
                    ? 'text-status-red'
                    : undefined,
              )}
            >
              {formatInr(totals.net)}
            </span>
          }
        />
        <StatCard
          label="Total out (incl. loan / card repayments)"
          value={formatInr(totals.cashOut)}
          delta={{
            direction: 'flat',
            label: `${formatInr(totals.cashIn)} in`,
          }}
        />
      </div>

      {/* Trend + category breakdown */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Last 6 months</CardTitle>
            <CardDescription>Operating income vs expense per month.</CardDescription>
          </CardHeader>
          <CardContent>
            <FinanceTrendChart points={summary.monthly} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Expense by category</CardTitle>
            <CardDescription>{monthLabel(monthKey)} — where the money went.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.expenseByCategory.length === 0 ? (
              <EmptyState
                icon={Receipt}
                title="No expenses this month"
                description="Record money out and the breakdown will appear here."
                className="py-8"
              />
            ) : (
              <ul className="space-y-3">
                {summary.expenseByCategory.map((row) => {
                  const pct = maxExpense > 0 ? (row.amount / maxExpense) * 100 : 0;
                  return (
                    <li key={row.category} className="space-y-1">
                      <div className="flex items-center justify-between gap-3 text-sm">
                        <Link
                          href={`/finance/transactions?month=${monthKey}&category=${row.category}`}
                          className="truncate font-medium text-foreground hover:underline"
                        >
                          {row.label}
                        </Link>
                        <span className="shrink-0 tabular-nums text-foreground">
                          {formatInr(row.amount)}
                          <span className="ml-1 text-xs text-muted-foreground">
                            · {row.count}
                          </span>
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-status-red/70"
                          style={{ width: `${Math.max(2, pct)}%` }}
                        />
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Outstanding + accounts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Kitna dena hai — outstanding</CardTitle>
            <CardDescription>
              Loans taken from financers and spend on borrowed credit cards, minus what
              we&apos;ve paid back. All-time.
              {totalOwed > 0 ? (
                <span className="ml-1 font-medium text-foreground">
                  Total {formatInr(totalOwed)}.
                </span>
              ) : null}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.outstanding.length === 0 ? (
              <EmptyState
                icon={Users}
                title="Nothing outstanding"
                description="Loans and card spend you record will show up here until they are repaid."
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {summary.outstanding.map((row) => (
                  <li
                    key={row.partyId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <Link
                        href={`/finance/parties/${row.partyId}`}
                        className="block truncate text-sm font-medium text-foreground hover:underline"
                      >
                        {row.name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <StatusBadge
                          status={row.type}
                          tone={PARTY_TYPE_TONE[row.type]}
                          label={FINANCE_PARTY_TYPE_SHORT[row.type]}
                        />
                        {row.loanOutstanding !== 0 ? (
                          <span>Loan {formatInr(row.loanOutstanding)}</span>
                        ) : null}
                        {row.cardOutstanding !== 0 ? (
                          <span>Card {formatInr(row.cardOutstanding)}</span>
                        ) : null}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-sm font-semibold tabular-nums',
                        row.owed > 0 ? 'text-status-red' : 'text-status-green',
                      )}
                    >
                      {row.owed > 0 ? formatInr(row.owed) : `${formatInr(-row.owed)} extra paid`}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Accounts</CardTitle>
            <CardDescription>
              Balance = opening + money in − money out (all-time). This month&apos;s flow
              alongside.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {summary.accounts.length === 0 ? (
              <EmptyState
                icon={Landmark}
                title="No accounts yet"
                description="Add your bank, cash, UPI and any borrowed credit cards to track balances."
                action={
                  <Button asChild variant="outline" size="sm">
                    <Link href="/finance/accounts">Add account</Link>
                  </Button>
                }
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {summary.accounts.map((acc) => (
                  <li
                    key={acc.accountId}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {acc.name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {FINANCE_ACCOUNT_TYPE_LABELS[acc.type]}
                        {acc.ownerName ? ` · ${acc.ownerName}'s` : ''}
                        {acc.cashIn > 0 || acc.cashOut > 0 ? (
                          <>
                            {' '}· <span className="text-status-green">+{formatInr(acc.cashIn)}</span>{' '}
                            <span className="text-status-red">−{formatInr(acc.cashOut)}</span>
                          </>
                        ) : null}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-sm font-semibold tabular-nums',
                        acc.balance < 0 ? 'text-status-red' : 'text-foreground',
                      )}
                    >
                      {formatInr(acc.balance)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Recent + top parties */}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0">
            <div>
              <CardTitle className="text-base">Recent transactions</CardTitle>
              <CardDescription>{monthLabel(monthKey)}, newest first.</CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link href={`/finance/transactions?month=${monthKey}`}>View all</Link>
            </Button>
          </CardHeader>
          <CardContent>
            {summary.recent.length === 0 ? (
              <EmptyState
                icon={Wallet}
                title="No transactions this month"
                description="Use Money in / Money out above to record the first one."
                className="py-8"
              />
            ) : (
              <ul className="divide-y">
                {summary.recent.map((row) => (
                  <li key={row.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link
                        href={`/finance/transactions/${row.id}`}
                        className="block truncate text-sm font-medium text-foreground hover:underline"
                      >
                        {row.description || row.partyName || categoryLabel(row.category)}
                      </Link>
                      <div className="truncate text-xs text-muted-foreground">
                        {formatDateUtc(row.date)} · {categoryLabel(row.category)}
                        {row.partyName && row.description ? ` · ${row.partyName}` : ''}
                        {row.accountName ? ` · ${row.accountName}` : ''}
                      </div>
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-sm font-semibold tabular-nums',
                        amountClass(row.direction),
                      )}
                    >
                      {amountSign(row.direction)}
                      {formatInr(row.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top parties</CardTitle>
            <CardDescription>Who we paid / got paid by this month.</CardDescription>
          </CardHeader>
          <CardContent>
            {summary.topParties.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No party-linked transactions yet.
              </p>
            ) : (
              <ul className="divide-y">
                {summary.topParties.map((p) => (
                  <li key={p.partyId} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <Link
                        href={`/finance/parties/${p.partyId}`}
                        className="block truncate text-sm font-medium text-foreground hover:underline"
                      >
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted-foreground">
                        {FINANCE_PARTY_TYPE_SHORT[p.type]}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-xs tabular-nums">
                      {p.paidTo > 0 ? (
                        <div className="text-status-red">−{formatInr(p.paidTo)}</div>
                      ) : null}
                      {p.receivedFrom > 0 ? (
                        <div className="text-status-green">+{formatInr(p.receivedFrom)}</div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
