/**
 * `/finance/transactions` — the ledger. Filters live in the URL; totals
 * shown above the table cover the WHOLE filtered set, not just the page.
 *
 * `?month=YYYY-MM` defaults to the current UTC month; `?month=all` lifts
 * the date filter entirely. Admin-only.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatInr, monthLabel, summarizeRows, toMonthKey } from '@/lib/finance';
import {
  buildTransactionOrderBy,
  buildTransactionWhere,
} from '@/lib/finance-query';
import {
  financeTransactionListQuerySchema,
  financeTransactionProjection,
  type FinanceTransactionPublic,
} from '@/lib/schemas/finance';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';
import { StatCard } from '@/components/shared/StatCard';
import { cn } from '@/lib/utils';

import { ExportDialog } from '../export-dialog';
import { FinanceNav } from '../finance-nav';
import { ALL_MONTHS } from '../finance-ui';
import { TransactionsFilters } from './transactions-filters';
import { TransactionsTable } from './transactions-table';

export const metadata = {
  title: 'Transactions · Finance',
};

export const dynamic = 'force-dynamic';

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.find((v) => v.length > 0);
  return raw === '' ? undefined : raw;
}

interface TransactionsPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function TransactionsPage({
  searchParams,
}: TransactionsPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance/transactions');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // Month handling: absent → current month, 'all' → no date filter.
  const rawMonth = rawParams.month;
  const monthParam: string =
    rawMonth === ALL_MONTHS
      ? ALL_MONTHS
      : rawMonth && /^\d{4}-\d{2}$/.test(rawMonth)
        ? rawMonth
        : toMonthKey(new Date());
  if (monthParam === ALL_MONTHS) {
    delete rawParams.month;
  } else {
    rawParams.month = monthParam;
  }

  const parsed = financeTransactionListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : financeTransactionListQuerySchema.parse(
        monthParam === ALL_MONTHS ? {} : { month: monthParam },
      );

  const where = buildTransactionWhere(query);
  const orderBy = buildTransactionOrderBy(query);
  const skip = (query.page - 1) * query.pageSize;

  const [items, total, allMatching, partyRows, accountRows] = await Promise.all([
    prisma.financeTransaction.findMany({
      where,
      select: financeTransactionProjection,
      orderBy,
      skip,
      take: query.pageSize,
    }),
    prisma.financeTransaction.count({ where }),
    prisma.financeTransaction.findMany({
      where,
      select: { direction: true, category: true, amount: true },
    }),
    prisma.financeParty.findMany({
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
      take: 500,
    }),
    prisma.financeAccount.findMany({
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
      take: 200,
    }),
  ]);

  const totals = summarizeRows(allMatching);
  const singleCategory =
    query.category && query.category.length === 1 ? query.category[0] : '';

  const windowLabel =
    monthParam === ALL_MONTHS ? 'All time' : monthLabel(monthParam);

  const newHrefBase = `/finance/transactions/new?month=${monthParam}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle={`${windowLabel} — every rupee in and out.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportDialog defaultMonth={monthParam} />
            <Button asChild variant="outline" size="sm">
              <Link href={`${newHrefBase}&direction=IN`}>
                <ArrowDownLeft className="h-4 w-4" aria-hidden="true" />
                <span>Money in</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href={`${newHrefBase}&direction=OUT`}>
                <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                <span>Money out</span>
              </Link>
            </Button>
          </div>
        }
      />

      <FinanceNav />

      <TransactionsFilters
        defaultMonth={monthParam}
        defaultDirection={query.direction ?? ''}
        defaultCategory={singleCategory}
        defaultPartyId={query.partyId ?? ''}
        defaultAccountId={query.accountId ?? ''}
        defaultSearch={query.search ?? ''}
        parties={partyRows}
        accounts={accountRows}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Money in (filtered)" value={formatInr(totals.cashIn)} />
        <StatCard
          label="Money out (filtered)"
          value={formatInr(totals.cashOut)}
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
          delta={{
            direction: 'flat',
            label: `${total} row${total === 1 ? '' : 's'}`,
          }}
        />
      </div>

      <TransactionsTable
        items={items as unknown as FinanceTransactionPublic[]}
        newHref={`${newHrefBase}&direction=OUT`}
      />

      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        basePath="/finance/transactions"
        searchParams={{
          month: monthParam,
          direction: query.direction,
          category: singleCategory || undefined,
          partyId: query.partyId,
          accountId: query.accountId,
          search: query.search,
          sortBy: query.sortBy !== 'date' ? query.sortBy : undefined,
          sortDir: query.sortDir !== 'desc' ? query.sortDir : undefined,
        }}
      />
    </div>
  );
}
