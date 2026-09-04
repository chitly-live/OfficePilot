/**
 * `/finance/transactions/new` — record one ledger row.
 *
 * Accepts prefills via the query string so the overview / party pages
 * can deep-link: `?direction=IN|OUT&category=&partyId=&accountId=&month=`.
 * Admin-only.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { FinanceCategory, FinanceDirection } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';

import { FinanceNav } from '../../finance-nav';
import { ALL_MONTHS } from '../../finance-ui';
import { TransactionForm } from '../transaction-form';

export const metadata = {
  title: 'New transaction · Finance',
};

export const dynamic = 'force-dynamic';

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw === '' ? undefined : raw;
}

interface NewTransactionPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function NewTransactionPage({
  searchParams,
}: NewTransactionPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance/transactions/new');
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const rawDirection = coerceParam(searchParams?.direction);
  const direction: FinanceDirection =
    rawDirection === 'IN' || rawDirection === 'OUT' ? rawDirection : 'OUT';

  const rawCategory = coerceParam(searchParams?.category);
  const category =
    rawCategory && (Object.values(FinanceCategory) as string[]).includes(rawCategory)
      ? (rawCategory as FinanceCategory)
      : undefined;

  const partyId = coerceParam(searchParams?.partyId);
  const accountId = coerceParam(searchParams?.accountId);
  const month = coerceParam(searchParams?.month);
  const returnToRaw = coerceParam(searchParams?.returnTo);
  const returnTo =
    returnToRaw && returnToRaw.startsWith('/finance') && !returnToRaw.startsWith('//')
      ? returnToRaw
      : month && (month === ALL_MONTHS || /^\d{4}-\d{2}$/.test(month))
        ? `/finance/transactions?month=${month}`
        : '/finance/transactions';

  const [partyRows, accountRows] = await Promise.all([
    prisma.financeParty.findMany({
      where: { isActive: true },
      select: { id: true, name: true, type: true },
      orderBy: [{ name: 'asc' }],
      take: 500,
    }),
    prisma.financeAccount.findMany({
      where: { isActive: true },
      select: {
        id: true,
        name: true,
        type: true,
        ownerParty: { select: { name: true } },
      },
      orderBy: [{ name: 'asc' }],
      take: 200,
    }),
  ]);

  const parties = partyRows;
  const accounts = accountRows.map((a) => ({
    id: a.id,
    name: a.name,
    type: a.type,
    ownerName: a.ownerParty?.name ?? null,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={direction === 'IN' ? 'Record money in' : 'Record money out'}
        subtitle="Date, amount, category — and who it went to or came from."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href={returnTo}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back</span>
            </Link>
          </Button>
        }
      />

      <FinanceNav />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Transaction details</CardTitle>
          <CardDescription>
            Loans and card repayments are tracked separately from expenses so
            the net figure stays honest.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionForm
            mode="create"
            parties={parties}
            accounts={accounts}
            initialValues={{
              direction,
              ...(category ? { category } : {}),
              ...(partyId && parties.some((p) => p.id === partyId) ? { partyId } : {}),
              ...(accountId && accounts.some((a) => a.id === accountId)
                ? { accountId }
                : {}),
            }}
            returnTo={returnTo}
          />
        </CardContent>
      </Card>
    </div>
  );
}
