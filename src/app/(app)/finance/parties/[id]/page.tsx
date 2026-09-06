/**
 * `/finance/parties/[id]` — one party: what we owe them, their ledger,
 * accounts they lent us, and quick links to record the next payment.
 * Admin-only.
 */

import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Mail, Phone } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_PARTY_TYPE_LABELS,
  FINANCE_PARTY_TYPE_SHORT,
  computePassThrough,
  formatInr,
} from '@/lib/finance';
import { loadPartyBalance } from '@/lib/finance-summary';
import { loadProducts } from '@/lib/products-server';
import {
  financePartyProjection,
  financeTransactionProjection,
  type FinancePartyPublic,
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
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { FinanceNav } from '../../finance-nav';
import { PARTY_TYPE_TONE } from '../../finance-ui';
import { TransactionsTable } from '../../transactions/transactions-table';
import { DeletePartyButton } from '../delete-party-button';
import { PartyDialog } from '../party-dialog';

export const dynamic = 'force-dynamic';

const LEDGER_LIMIT = 100;

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const party = await prisma.financeParty.findUnique({
    where: { id: params.id },
    select: { name: true },
  });
  return { title: party ? `${party.name} · Finance` : 'Party · Finance' };
}

export default async function PartyDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/finance/parties/${params.id}`);
  }
  if (session.role !== 'ADMIN') {
    redirect('/dashboard');
  }

  const [partyRow, ledgerRows, accounts, routedRows, productRows, productSplitRows] = await Promise.all([
    prisma.financeParty.findUnique({
      where: { id: params.id },
      select: financePartyProjection,
    }),
    prisma.financeTransaction.findMany({
      where: {
        OR: [
          { partyId: params.id },
          { viaPartyId: params.id },
          { account: { ownerPartyId: params.id } },
        ],
      },
      select: financeTransactionProjection,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
      take: LEDGER_LIMIT,
    }),
    prisma.financeAccount.findMany({
      where: { ownerPartyId: params.id },
      select: { id: true, name: true, type: true, isActive: true },
      orderBy: [{ name: 'asc' }],
    }),
    // Money that only passed through this party on its way to someone else.
    prisma.financeTransaction.findMany({
      where: { viaPartyId: params.id },
      select: { direction: true, category: true, amount: true, viaPartyId: true },
    }),
    loadProducts(prisma, { includeInactive: true }),
    // Product split: rows linked to this party or made on their accounts.
    prisma.financeTransaction.findMany({
      where: {
        OR: [{ partyId: params.id }, { account: { ownerPartyId: params.id } }],
      },
      select: { productId: true, direction: true, amount: true },
    }),
  ]);
  if (!partyRow) notFound();

  const productSplit = (() => {
    const byId = new Map(productRows.map((p) => [p.id, p]));
    const acc = new Map<string | null, { name: string; color: string | null; paidTo: number; receivedFrom: number; count: number }>();
    for (const r of productSplitRows) {
      const key = r.productId && byId.has(r.productId) ? r.productId : null;
      const meta = key ? byId.get(key)! : { name: 'Company-level', color: null };
      const bucket = acc.get(key) ?? { name: meta.name, color: meta.color, paidTo: 0, receivedFrom: 0, count: 0 };
      bucket.count += 1;
      if (r.direction === 'OUT') bucket.paidTo += r.amount;
      else bucket.receivedFrom += r.amount;
      acc.set(key, bucket);
    }
    return [...acc.entries()]
      .map(([productId, v]) => ({ productId, ...v }))
      .sort((a, b) => b.paidTo + b.receivedFrom - (a.paidTo + a.receivedFrom));
  })();

  const party = partyRow as unknown as FinancePartyPublic;
  const balance = await loadPartyBalance(prisma, party.id);
  const passThrough = computePassThrough(routedRows, party.id);
  const ledger = ledgerRows as unknown as FinanceTransactionPublic[];

  const isLender = party.type === 'FINANCER' || party.type === 'CARD_OWNER';
  const newBase = `/finance/transactions/new?partyId=${party.id}&returnTo=/finance/parties/${party.id}`;

  const quickLinks: Array<{ href: string; label: string; icon: typeof ArrowUpRight; primary?: boolean }> = [];
  if (party.type === 'FINANCER') {
    quickLinks.push(
      { href: `${newBase}&direction=IN&category=LOAN_RECEIVED`, label: 'Loan received', icon: ArrowDownLeft },
      { href: `${newBase}&direction=OUT&category=LOAN_REPAYMENT`, label: 'Repay loan', icon: ArrowUpRight, primary: true },
    );
  } else if (party.type === 'CARD_OWNER') {
    quickLinks.push({
      href: `${newBase}&direction=OUT&category=CARD_REPAYMENT`,
      label: 'Settle card',
      icon: ArrowUpRight,
      primary: true,
    });
  } else if (party.type === 'WORKER') {
    quickLinks.push({
      href: `${newBase}&direction=OUT&category=PAYOUT`,
      label: 'Record payout',
      icon: ArrowUpRight,
      primary: true,
    });
  } else if (party.type === 'EMPLOYEE') {
    quickLinks.push({
      href: `${newBase}&direction=OUT&category=SALARY`,
      label: 'Record salary',
      icon: ArrowUpRight,
      primary: true,
    });
  } else if (party.type === 'CLIENT') {
    quickLinks.push({
      href: `${newBase}&direction=IN&category=SALES`,
      label: 'Record payment received',
      icon: ArrowDownLeft,
      primary: true,
    });
  } else {
    quickLinks.push({
      href: `${newBase}&direction=OUT`,
      label: 'Record payment',
      icon: ArrowUpRight,
      primary: true,
    });
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{party.name}</span>
            <StatusBadge
              status={party.type}
              tone={PARTY_TYPE_TONE[party.type]}
              label={FINANCE_PARTY_TYPE_SHORT[party.type]}
            />
            {!party.isActive ? (
              <StatusBadge status="INACTIVE" tone="neutral" label="Inactive" />
            ) : null}
          </span>
        }
        subtitle={FINANCE_PARTY_TYPE_LABELS[party.type]}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/finance/parties">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back</span>
              </Link>
            </Button>
            {party.userId ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/employees/${party.userId}`}>Employee profile</Link>
              </Button>
            ) : null}
            {quickLinks.map((q) => {
              const Icon = q.icon;
              return (
                <Button
                  key={q.href}
                  asChild
                  size="sm"
                  variant={q.primary ? 'default' : 'outline'}
                >
                  <Link href={q.href}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                    <span>{q.label}</span>
                  </Link>
                </Button>
              );
            })}
            <PartyDialog mode="edit" party={party} />
            <DeletePartyButton partyId={party.id} partyName={party.name} />
          </div>
        }
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="We owe"
          value={
            <span
              className={cn(
                balance.owed > 0
                  ? 'text-status-red'
                  : balance.owed < 0
                    ? 'text-status-green'
                    : undefined,
              )}
            >
              {formatInr(balance.owed)}
            </span>
          }
          delta={
            balance.owed < 0
              ? { direction: 'down', label: 'paid more than owed' }
              : undefined
          }
        />
        <StatCard
          label="Loan outstanding"
          value={formatInr(balance.loanOutstanding)}
          delta={{
            direction: 'flat',
            label: `${formatInr(balance.loanReceived)} taken · ${formatInr(balance.loanRepaid)} repaid`,
          }}
        />
        <StatCard
          label="Card outstanding"
          value={formatInr(balance.cardOutstanding)}
          delta={{
            direction: 'flat',
            label: `${formatInr(balance.cardSpend)} spent · ${formatInr(balance.cardRepaid)} settled`,
          }}
        />
        <StatCard label="Paid to them (all-time)" value={formatInr(balance.paidTo)} />
        <StatCard label="Received from them" value={formatInr(balance.receivedFrom)} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Ledger</CardTitle>
              <CardDescription>
                Every transaction linked to {party.name}
                {accounts.length > 0 ? ' or made through their accounts' : ''}.
                {ledger.length === LEDGER_LIMIT ? ` Showing the latest ${LEDGER_LIMIT}.` : ''}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <TransactionsTable
                items={ledger}
                showParty={false}
                newHref={quickLinks[0]?.href ?? `${newBase}&direction=OUT`}
              />
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          {productSplit.length > 1 || (productSplit.length === 1 && productSplit[0].productId !== null) ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">By product</CardTitle>
                <CardDescription>
                  All-time money to / from {party.name}, split by business line.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {productSplit.map((row) => (
                  <div key={row.productId ?? 'company'} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color ?? '#94a3b8' }}
                      />
                      <span className="truncate">{row.name}</span>
                      <span className="text-xs text-muted-foreground">· {row.count}</span>
                    </span>
                    <span className="shrink-0 text-right text-xs tabular-nums">
                      {row.paidTo > 0 ? <div className="text-status-red">−{formatInr(row.paidTo)}</div> : null}
                      {row.receivedFrom > 0 ? (
                        <div className="text-status-green">+{formatInr(row.receivedFrom)}</div>
                      ) : null}
                    </span>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          {passThrough.count > 0 ? (
            <Card className="border-status-amber/40">
              <CardHeader>
                <CardTitle className="text-base">Money routed through {party.name}</CardTitle>
                <CardDescription>
                  The bank paid {party.name}, who passed it on to the real party.
                  These amounts are shown for tracking only and are{' '}
                  <span className="font-medium text-foreground">not</span> counted as
                  paid to or owed by {party.name}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1 text-sm">
                {passThrough.routedOut > 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Routed out through them</span>
                    <span className="font-semibold tabular-nums">{formatInr(passThrough.routedOut)}</span>
                  </div>
                ) : null}
                {passThrough.routedIn > 0 ? (
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Routed in through them</span>
                    <span className="font-semibold tabular-nums">{formatInr(passThrough.routedIn)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Entries</span>
                  <span>{passThrough.count}</span>
                </div>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Contact</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {party.phone ? (
                <div className="flex items-center gap-2">
                  <Phone className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span>{party.phone}</span>
                </div>
              ) : null}
              {party.email ? (
                <div className="flex items-center gap-2">
                  <Mail className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{party.email}</span>
                </div>
              ) : null}
              {!party.phone && !party.email ? (
                <p className="text-muted-foreground">No contact details.</p>
              ) : null}
              {party.notes ? (
                <p className="whitespace-pre-wrap border-t pt-2 text-muted-foreground">
                  {party.notes}
                </p>
              ) : null}
            </CardContent>
          </Card>

          {isLender || accounts.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Their accounts</CardTitle>
                <CardDescription>
                  Cards / accounts they lent us. Spend on these counts towards what we owe.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {accounts.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    None yet.{' '}
                    <Link href="/finance/accounts" className="underline">
                      Add an account
                    </Link>{' '}
                    and set {party.name} as the owner.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {accounts.map((a) => (
                      <li key={a.id} className="flex items-center justify-between py-2 text-sm">
                        <span className="truncate">{a.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {FINANCE_ACCOUNT_TYPE_LABELS[a.type]}
                          {!a.isActive ? ' · inactive' : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
