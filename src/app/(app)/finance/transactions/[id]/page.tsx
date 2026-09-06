/**
 * `/finance/transactions/[id]` — edit or delete one ledger row.
 * Admin-only.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getProductContext, loadProducts } from '@/lib/products-server';
import {
  FINANCE_CATEGORY_META,
  formatDateUtc,
  formatInr,
  toMonthKey,
} from '@/lib/finance';
import {
  financeTransactionProjection,
  type FinanceTransactionPublic,
} from '@/lib/schemas/finance';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';

import { FinanceNav } from '../../finance-nav';
import { directionTone, toDateInputValue } from '../../finance-ui';
import { DeleteTransactionButton } from '../delete-transaction-button';
import { TransactionForm } from '../transaction-form';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const row = await prisma.financeTransaction.findUnique({
    where: { id: params.id },
    select: { description: true, category: true },
  });
  if (!row) return { title: 'Transaction · Finance' };
  return {
    title: `${row.description || FINANCE_CATEGORY_META[row.category].label} · Finance`,
  };
}

export default async function TransactionDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/finance/transactions/${params.id}`);
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const [row, partyRows, accountRows, productRows, productContext] = await Promise.all([
    prisma.financeTransaction.findUnique({
      where: { id: params.id },
      select: financeTransactionProjection,
    }),
    prisma.financeParty.findMany({
      select: { id: true, name: true, type: true, isActive: true },
      orderBy: [{ name: 'asc' }],
      take: 500,
    }),
    prisma.financeAccount.findMany({
      select: {
        id: true,
        name: true,
        type: true,
        isActive: true,
        ownerParty: { select: { name: true } },
      },
      orderBy: [{ name: 'asc' }],
      take: 200,
    }),
    loadProducts(prisma, { includeInactive: true }),
    getProductContext(prisma),
  ]);
  if (!row) notFound();

  const txn = row as unknown as FinanceTransactionPublic;

  // Active options, plus whatever this row already points at (even if
  // it has since been marked inactive) so the select never loses it.
  const parties = partyRows
    .filter((p) => p.isActive || p.id === txn.partyId || p.id === txn.viaPartyId)
    .map((p) => ({ id: p.id, name: p.name, type: p.type }));
  const accounts = accountRows
    .filter((a) => a.isActive || a.id === txn.accountId)
    .map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      ownerName: a.ownerParty?.name ?? null,
    }));

  const products = productRows
    .filter((p) => p.isActive || p.id === txn.productId)
    .map((p) => ({ id: p.id, name: p.name, color: p.color }));

  const meta = FINANCE_CATEGORY_META[txn.category];
  const label =
    txn.description || txn.party?.name || meta.label;
  const returnTo = `/finance/transactions?month=${toMonthKey(new Date(txn.date))}`;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="truncate">{label}</span>
            <StatusBadge
              status={txn.direction}
              tone={directionTone(txn.direction)}
              label={`${txn.direction === 'IN' ? '+' : '−'}${formatInr(txn.amount)}`}
            />
          </span>
        }
        subtitle={`${formatDateUtc(txn.date)} · ${meta.label}${
          txn.account ? ` · ${txn.account.name}` : ''
        } · recorded by ${txn.createdBy.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href={returnTo}>
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back</span>
              </Link>
            </Button>
            <DeleteTransactionButton
              transactionId={txn.id}
              label={label}
              returnTo={returnTo}
            />
          </div>
        }
      />

      <FinanceNav />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Edit transaction</CardTitle>
          <CardDescription>
            Changing the party or account re-computes what we owe them.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <TransactionForm
            mode="edit"
            transactionId={txn.id}
            parties={parties}
            accounts={accounts}
            products={products}
            companyLabel={`${productContext.companyShort} (company-level, no product)`}
            initialValues={{
              direction: txn.direction,
              productId: txn.productId ?? undefined,
              date: toDateInputValue(txn.date),
              amount: String(txn.amount),
              category: txn.category,
              partyId: txn.partyId ?? undefined,
              viaPartyId: txn.viaPartyId ?? undefined,
              settlesAccountId: txn.settlesAccountId ?? undefined,
              accountId: txn.accountId ?? undefined,
              description: txn.description ?? '',
              reference: txn.reference ?? '',
              hasOriginal: txn.originalAmount !== null && txn.originalCurrency !== null,
              originalAmount:
                txn.originalAmount !== null ? String(txn.originalAmount) : '',
              originalCurrency: txn.originalCurrency ?? 'USD',
              dueDate: toDateInputValue(txn.dueDate),
            }}
            returnTo={returnTo}
          />
        </CardContent>
      </Card>
    </div>
  );
}
