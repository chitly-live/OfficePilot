/**
 * `/finance/assets/[id]` — one asset: the facts, who has it now, the payment
 * that bought it, and every hand-over since.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';
import { canManageFinance, canViewFinance } from '@/lib/permissions';
import { prisma } from '@/lib/db';
import { formatDateUtc, formatInr, toDateKey } from '@/lib/finance';
import {
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
  ASSET_STATUS_TONE,
  currentHolder,
  renewalState,
} from '@/lib/assets';
import { loadAssetPayments, loadAssetPeople } from '@/lib/assets-server';
import { assetProjection } from '@/lib/schemas/assets';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { FinanceNav } from '../../finance-nav';
import { AssetDialog } from '../asset-dialog';
import { DeleteAssetButton } from '../delete-asset-button';
import { HandoverDialog } from '../handover-dialog';

export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const a = await prisma.asset.findUnique({ where: { id: params.id }, select: { name: true } });
  return { title: a ? `${a.name} · Assets` : 'Asset · Finance' };
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-foreground">{children}</dd>
    </div>
  );
}

export default async function AssetDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) redirect(`/login?callbackUrl=/finance/assets/${params.id}`);
  if (!canViewFinance(session.role)) redirect('/dashboard');
  const canEdit = canManageFinance(session.role);

  const asset = await prisma.asset.findUnique({ where: { id: params.id }, select: assetProjection });
  if (!asset) notFound();

  const [people, payments] = await Promise.all([
    loadAssetPeople(prisma),
    canEdit ? loadAssetPayments(prisma, asset.transactionId) : Promise.resolve([]),
  ]);
  const holder = currentHolder(asset.assignments);
  const renew = renewalState(asset.renewsOn, new Date());
  const holderHref =
    holder.kind === 'party'
      ? `/finance/parties/${holder.id}`
      : holder.kind === 'user' && canEdit
        ? `/employees/${holder.id}`
        : null;

  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/finance/assets">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Assets</span>
          </Link>
        </Button>
      </div>

      <PageHeader
        title={asset.name}
        subtitle={[asset.category, asset.identifier].filter(Boolean).join(' · ') || ASSET_KIND_LABELS[asset.kind]}
        actions={
          canEdit ? (
            <div className="flex flex-wrap gap-2">
              <HandoverDialog assetId={asset.id} assetName={asset.name} currentHolderName={holder.name} people={people} />
              <AssetDialog
                mode="edit"
                people={people}
                payments={payments}
                asset={{
                  id: asset.id,
                  name: asset.name,
                  kind: asset.kind,
                  category: asset.category,
                  identifier: asset.identifier,
                  purchaseDate: asset.purchaseDate ? toDateKey(asset.purchaseDate) : '',
                  cost: asset.cost,
                  transactionId: asset.transactionId,
                  status: asset.status,
                  renewsOn: asset.renewsOn ? toDateKey(asset.renewsOn) : '',
                  notes: asset.notes,
                }}
              />
              <DeleteAssetButton assetId={asset.id} name={asset.name} />
            </div>
          ) : undefined
        }
      />

      <FinanceNav />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-base">Right now</CardTitle>
            <CardDescription>Who has it and where.</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-lg font-semibold">
              {holderHref ? (
                <Link href={holderHref} className="hover:underline">
                  {holder.name}
                </Link>
              ) : (
                holder.name
              )}
            </p>
            <p className="text-sm text-muted-foreground">
              {holder.location ? `${holder.location} · ` : ''}
              {holder.since ? `since ${formatDateUtc(holder.since)}` : 'never handed out'}
            </p>
            <div className="mt-3">
              <StatusBadge status={asset.status} tone={ASSET_STATUS_TONE[asset.status]} label={ASSET_STATUS_LABELS[asset.status]} />
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 sm:grid-cols-3">
              <Fact label="Kind">{ASSET_KIND_LABELS[asset.kind]}</Fact>
              <Fact label="Bought on">{asset.purchaseDate ? formatDateUtc(asset.purchaseDate) : '—'}</Fact>
              <Fact label="Cost">{asset.cost != null ? formatInr(asset.cost) : '—'}</Fact>
              <Fact label="Paid by">
                {asset.transaction ? (
                  canEdit ? (
                    <Link href={`/finance/transactions/${asset.transaction.id}`} className="text-primary hover:underline">
                      {formatDateUtc(asset.transaction.date)} · {formatInr(asset.transaction.amount)}
                      {asset.transaction.account ? ` · ${asset.transaction.account.name}` : ''}
                    </Link>
                  ) : (
                    <span>
                      {formatDateUtc(asset.transaction.date)} · {formatInr(asset.transaction.amount)}
                      {asset.transaction.account ? ` · ${asset.transaction.account.name}` : ''}
                    </span>
                  )
                ) : (
                  <span className="text-status-amber">Not linked to a payment</span>
                )}
              </Fact>
              <Fact label="Renews on">
                <span
                  className={cn(
                    renew === 'overdue' && 'font-medium text-status-red',
                    renew === 'soon' && 'font-medium text-status-amber',
                  )}
                >
                  {asset.renewsOn ? formatDateUtc(asset.renewsOn) : '—'}
                  {renew === 'overdue' ? ' (overdue)' : renew === 'soon' ? ' (soon)' : ''}
                </span>
              </Fact>
              <Fact label="Serial / number">{asset.identifier || '—'}</Fact>
            </dl>
            {asset.transaction && asset.cost != null && Math.abs(asset.transaction.amount - asset.cost) >= 0.01 ? (
              <p className="mt-4 text-xs text-status-amber">
                Cost {formatInr(asset.cost)} differs from the payment {formatInr(asset.transaction.amount)} — fine if
                one payment bought several things.
              </p>
            ) : null}
            {asset.notes ? <p className="mt-4 whitespace-pre-wrap text-sm text-muted-foreground">{asset.notes}</p> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Hand-over history</CardTitle>
          <CardDescription>Every person and place it has been, newest first.</CardDescription>
        </CardHeader>
        <CardContent>
          {asset.assignments.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Never handed out — it has been with the company since it was bought.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">With</th>
                    <th className="py-2 pr-3 font-medium">Where</th>
                    <th className="py-2 pr-3 font-medium">From</th>
                    <th className="py-2 pr-3 font-medium">To</th>
                    <th className="py-2 pr-3 font-medium">Note</th>
                    <th className="py-2 font-medium">Recorded by</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {asset.assignments.map((h) => (
                    <tr key={h.id}>
                      <td className="py-2 pr-3 font-medium">
                        {h.toUser?.name ?? h.toParty?.name ?? <span className="text-muted-foreground">Company</span>}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{h.location ?? '—'}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateUtc(h.fromDate)}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">
                        {h.toDate ? formatDateUtc(h.toDate) : <span className="text-status-green">now</span>}
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">{h.note ?? ''}</td>
                      <td className="py-2 text-muted-foreground">{h.createdBy.name}</td>
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
