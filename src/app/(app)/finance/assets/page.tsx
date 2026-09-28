/**
 * `/finance/assets` — everything we bought and still own: who has it, where
 * it is, what it cost, and which domains / subscriptions renew soon.
 * Admin edits; the accountant reads.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Package } from 'lucide-react';
import { AssetStatus, type Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { canManageFinance, canViewFinance } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { formatDateUtc, formatInr } from '@/lib/finance';
import {
  ASSET_STATUS_LABELS,
  ASSET_STATUS_TONE,
  currentHolder,
  renewalState,
  summarizeAssets,
} from '@/lib/assets';
import { loadAssetPayments, loadAssetPeople } from '@/lib/assets-server';
import { assetProjection } from '@/lib/schemas/assets';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { FinanceNav } from '../finance-nav';
import { AssetDialog } from './asset-dialog';
import { AssetsFilters } from './assets-filters';

export const metadata = { title: 'Assets · Finance' };
export const dynamic = 'force-dynamic';

function param(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return v ? v : undefined;
}

interface AssetsPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function AssetsPage({ searchParams }: AssetsPageProps) {
  const session = await auth();
  if (!session?.userId) redirect('/login?callbackUrl=/finance/assets');
  if (!canViewFinance(session.role)) redirect('/dashboard');
  const canEdit = canManageFinance(session.role);

  const status = param(searchParams?.status);
  const holder = param(searchParams?.holder);
  const search = param(searchParams?.search);
  const fromTxn = param(searchParams?.transaction);

  const where: Prisma.AssetWhereInput = {};
  if (status && status in AssetStatus) where.status = status as AssetStatus;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: 'insensitive' } },
      { identifier: { contains: search, mode: 'insensitive' } },
      { category: { contains: search, mode: 'insensitive' } },
    ];
  }
  if (holder) {
    const [kind, id] = holder.split(':');
    if (kind === 'user' && id) where.assignments = { some: { toDate: null, toUserId: id } };
    if (kind === 'party' && id) where.assignments = { some: { toDate: null, toPartyId: id } };
  }

  const today = new Date();
  const [assets, all, people, payments, presetTxn] = await Promise.all([
    prisma.asset.findMany({ where, select: assetProjection, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
    prisma.asset.findMany({ select: { status: true, cost: true, renewsOn: true } }),
    loadAssetPeople(prisma),
    canEdit ? loadAssetPayments(prisma, fromTxn) : Promise.resolve([]),
    canEdit && fromTxn
      ? prisma.financeTransaction.findUnique({
          where: { id: fromTxn },
          select: { id: true, date: true, amount: true, description: true, asset: { select: { id: true } } },
        })
      : Promise.resolve(null),
  ]);
  const summary = summarizeAssets(all, today);

  // "Record as asset" from a ledger row opens the dialog pre-filled.
  const preset =
    presetTxn && !presetTxn.asset
      ? {
          name: presetTxn.description ?? '',
          purchaseDate: presetTxn.date.toISOString().slice(0, 10),
          cost: presetTxn.amount,
          transactionId: presetTxn.id,
        }
      : undefined;

  const holderOptions = [
    ...people.users.map((u) => ({ value: `user:${u.id}`, label: u.name })),
    ...people.parties.map((p) => ({ value: `party:${p.id}`, label: p.name })),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Assets"
        subtitle="What we bought and still own — who has it, where, and what it cost."
        actions={
          canEdit ? (
            <AssetDialog mode="create" people={people} payments={payments} preset={preset} defaultOpen={Boolean(preset)} />
          ) : undefined
        }
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Owned" value={summary.owned} />
        <StatCard label="Cost of what we own" value={formatInr(summary.ownedCost)} />
        <StatCard label="With people / in stock" value={`${summary.inUse} / ${summary.inStock}`} />
        <StatCard
          label="Renewals in 30 days"
          value={
            <span className={cn(summary.renewalsDue > 0 && 'text-status-amber')}>{summary.renewalsDue}</span>
          }
        />
      </div>

      <AssetsFilters
        defaultSearch={search ?? ''}
        defaultStatus={status ?? ''}
        defaultHolder={holder ?? ''}
        holders={holderOptions}
      />

      {assets.length === 0 ? (
        <EmptyState
          icon={Package}
          title={all.length === 0 ? 'No assets yet' : 'Nothing matches these filters'}
          description={
            all.length === 0
              ? 'Add the laptops, phones, SIMs, domains and subscriptions the company owns, and who has each.'
              : 'Clear a filter to see more.'
          }
          action={
            canEdit && all.length === 0 ? (
              <AssetDialog mode="create" people={people} payments={payments} />
            ) : undefined
          }
        />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Asset</th>
                <th className="px-4 py-2 font-medium">Who has it</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Cost</th>
                <th className="px-4 py-2 font-medium">Bought</th>
                <th className="px-4 py-2 font-medium">Renews</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assets.map((a) => {
                const h = currentHolder(a.assignments);
                const renew = renewalState(a.renewsOn, today);
                return (
                  <tr key={a.id} className="hover:bg-muted/40">
                    <td className="px-4 py-2">
                      <Link href={`/finance/assets/${a.id}`} className="font-medium text-foreground hover:underline">
                        {a.name}
                      </Link>
                      <span className="block text-xs text-muted-foreground">
                        {[a.category, a.identifier].filter(Boolean).join(' · ') || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className={cn(h.kind === 'company' && 'text-muted-foreground')}>{h.name}</span>
                      {h.location ? (
                        <span className="block text-xs text-muted-foreground">{h.location}</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={a.status} tone={ASSET_STATUS_TONE[a.status]} label={ASSET_STATUS_LABELS[a.status]} />
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {a.cost != null ? formatInr(a.cost) : '—'}
                      {a.transaction ? null : a.cost != null ? (
                        <span className="block text-[11px] text-status-amber">no payment linked</span>
                      ) : null}
                    </td>
                    <td className="px-4 py-2 whitespace-nowrap text-muted-foreground">
                      {a.purchaseDate ? formatDateUtc(a.purchaseDate) : '—'}
                    </td>
                    <td
                      className={cn(
                        'px-4 py-2 whitespace-nowrap',
                        renew === 'overdue' && 'font-medium text-status-red',
                        renew === 'soon' && 'font-medium text-status-amber',
                        (renew === 'ok' || renew === null) && 'text-muted-foreground',
                      )}
                    >
                      {a.renewsOn ? formatDateUtc(a.renewsOn) : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
