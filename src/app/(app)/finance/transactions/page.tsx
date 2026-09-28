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
import type { Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { canManageFinance, canViewFinance } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { formatInr, monthLabel, summarizeRows, toMonthKey } from '@/lib/finance';
import { scopeLabel, scopeValue } from '@/lib/products';
import { getProductContext } from '@/lib/products-server';
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
  if (!canViewFinance(session.role)) {
    redirect('/dashboard');
  }
  const canEdit = canManageFinance(session.role);

  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // Bank charges (IMPS fee + its GST, AMB fee…) are a quarter of the rows
  // and a fraction of a percent of the money. They stay in the ledger —
  // line for line with the bank — but fold into one summary line here
  // unless asked for, filtered for, or searched for.
  const showCharges = rawParams.charges === 'show';
  delete rawParams.charges;

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

  // Header product switcher scopes the ledger (cookie, not URL).
  const productContext = await getProductContext(prisma);
  delete rawParams.productId;
  delete rawParams.companyOnly;
  if (productContext.scope.kind === 'product') {
    rawParams.productId = productContext.scope.product.id;
  } else if (productContext.scope.kind === 'company') {
    rawParams.companyOnly = '1';
  }

  const parsed = financeTransactionListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : financeTransactionListQuerySchema.parse({
        ...(monthParam === ALL_MONTHS ? {} : { month: monthParam }),
        ...(rawParams.productId ? { productId: rawParams.productId } : {}),
        ...(rawParams.companyOnly ? { companyOnly: rawParams.companyOnly } : {}),
      });

  const where = buildTransactionWhere(query);
  const orderBy = buildTransactionOrderBy(query);
  const skip = (query.page - 1) * query.pageSize;

  const foldCharges =
    !showCharges && !(query.category && query.category.length > 0) && !query.search;
  const listWhere: Prisma.FinanceTransactionWhereInput = foldCharges
    ? { AND: [where, { category: { not: 'BANK_CHARGES' } }] }
    : where;

  const [items, total, allMatching, partyRows, accountRows, folded] = await Promise.all([
    prisma.financeTransaction.findMany({
      where: listWhere,
      select: financeTransactionProjection,
      orderBy,
      skip,
      take: query.pageSize,
    }),
    prisma.financeTransaction.count({ where: listWhere }),
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
    foldCharges
      ? prisma.financeTransaction.aggregate({
          where: { AND: [where, { category: 'BANK_CHARGES' }] },
          _count: { _all: true },
          _sum: { amount: true },
        })
      : Promise.resolve(null),
  ]);

  // Totals always cover every matching row, folded or not.
  const totals = summarizeRows(allMatching);
  const foldedCount = folded?._count._all ?? 0;
  const foldedAmount = folded?._sum.amount ?? 0;
  const chargesLink = (show: boolean) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(searchParams ?? {})) {
      const val = coerceParam(v);
      if (val !== undefined && k !== 'charges' && k !== 'page') qs.set(k, val);
    }
    if (show) qs.set('charges', 'show');
    const str = qs.toString();
    return str ? `/finance/transactions?${str}` : '/finance/transactions';
  };
  const singleCategory =
    query.category && query.category.length === 1 ? query.category[0] : '';

  const windowLabel =
    monthParam === ALL_MONTHS ? 'All time' : monthLabel(monthParam);
  const scopeText = scopeLabel(productContext.scope, productContext.companyShort);

  const newHrefBase = `/finance/transactions/new?month=${monthParam}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        subtitle={`${windowLabel} · ${scopeText} — every rupee in and out.`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <ExportDialog
              defaultMonth={monthParam}
              product={scopeValue(productContext.scope)}
              productLabel={scopeText}
            />
            {canEdit ? (
              <>
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
              </>
            ) : null}
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
            label: `${total + foldedCount} row${total + foldedCount === 1 ? '' : 's'}`,
          }}
        />
      </div>

      {foldedCount > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
          <span>
            <span className="font-medium">{foldedCount} bank charge line{foldedCount === 1 ? '' : 's'}</span>{' '}
            <span className="text-muted-foreground">
              (IMPS / AMB fees and their GST) · {formatInr(foldedAmount)} — counted in the totals above, folded here.
            </span>
          </span>
          <Link href={chargesLink(true)} className="font-medium text-primary hover:underline">
            Show them
          </Link>
        </div>
      ) : showCharges ? (
        <div className="text-right text-xs">
          <Link href={chargesLink(false)} className="font-medium text-primary hover:underline">
            Fold bank charges
          </Link>
        </div>
      ) : null}

      <TransactionsTable
        items={items as unknown as FinanceTransactionPublic[]}
        newHref={`${newHrefBase}&direction=OUT`}
        readOnly={!canEdit}
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
          charges: showCharges ? 'show' : undefined,
        }}
      />
    </div>
  );
}
