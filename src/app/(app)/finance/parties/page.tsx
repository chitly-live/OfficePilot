/**
 * `/finance/parties` — everyone money moves between us and, with the
 * all-time "we owe" balance. Admin-only.
 */

import { redirect } from 'next/navigation';
import { FinancePartyType, Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { formatInr } from '@/lib/finance';
import { loadPartyBalances } from '@/lib/finance-summary';
import { productWhere, scopeLabel } from '@/lib/products';
import { getProductContext } from '@/lib/products-server';
import {
  financePartyListQuerySchema,
  financePartyProjection,
  type FinancePartyPublic,
} from '@/lib/schemas/finance';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';
import { StatCard } from '@/components/shared/StatCard';

import { FinanceNav } from '../finance-nav';
import { PartiesFilters } from './parties-filters';
import { PartiesTable, type PartyRow } from './parties-table';
import { PartyDialog } from './party-dialog';

export const metadata = {
  title: 'Parties · Finance',
};

export const dynamic = 'force-dynamic';

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw.find((v) => v.length > 0);
  return raw === '' ? undefined : raw;
}

interface PartiesPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function PartiesPage({ searchParams }: PartiesPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/finance/parties');
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
  const showInactive = rawParams.inactive === '1';
  delete rawParams.inactive;

  const parsed = financePartyListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : financePartyListQuerySchema.parse({});

  // Header product switcher: in a product / company-level scope only show
  // parties that actually have rows in that scope, with balances computed
  // from those rows alone.
  const productContext = await getProductContext(prisma);
  const scope = productContext.scope;
  const scopeText = scopeLabel(scope, productContext.companyShort);

  const where: Prisma.FinancePartyWhereInput = {};
  if (scope.kind !== 'all') {
    const scoped = await prisma.financeTransaction.findMany({
      where: productWhere(scope),
      select: { partyId: true, viaPartyId: true, account: { select: { ownerPartyId: true } } },
    });
    const ids = new Set<string>();
    for (const r of scoped) {
      if (r.partyId) ids.add(r.partyId);
      if (r.viaPartyId) ids.add(r.viaPartyId);
      if (r.account?.ownerPartyId) ids.add(r.account.ownerPartyId);
    }
    where.id = { in: [...ids] };
  }
  if (query.type && query.type.length > 0) where.type = { in: query.type };
  if (!showInactive) where.isActive = true;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { phone: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const skip = (query.page - 1) * query.pageSize;
  const [rows, total] = await Promise.all([
    prisma.financeParty.findMany({
      where,
      select: financePartyProjection,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip,
      take: query.pageSize,
    }),
    prisma.financeParty.count({ where }),
  ]);

  const balances = await loadPartyBalances(prisma, undefined, scope);
  const items: PartyRow[] = rows.map((p) => ({
    ...(p as unknown as FinancePartyPublic),
    balance: balances.get(p.id) ?? null,
  }));

  // Headline numbers across ALL parties (not just this page).
  let totalOwed = 0;
  let financerCount = 0;
  let cardOwnerCount = 0;
  const allParties = await prisma.financeParty.findMany({
    where: scope.kind !== 'all' ? { id: where.id } : {},
    select: { id: true, type: true },
  });
  for (const p of allParties) {
    const b = balances.get(p.id);
    if (b && b.owed > 0) totalOwed += b.owed;
    if (p.type === FinancePartyType.FINANCER) financerCount += 1;
    if (p.type === FinancePartyType.CARD_OWNER) cardOwnerCount += 1;
  }

  const singleType = query.type && query.type.length === 1 ? query.type[0] : '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Parties"
        subtitle={
          scope.kind === 'all'
            ? 'Financers, card owners, hosts, vendors, clients — and what we owe each.'
            : `${scopeText} — only parties with entries in this scope; balances count those entries alone.`
        }
        actions={<PartyDialog mode="create" />}
      />

      <FinanceNav />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard
          label="Total we owe"
          value={formatInr(totalOwed)}
          invertColor
        />
        <StatCard label="Financers" value={financerCount} />
        <StatCard label="Card owners" value={cardOwnerCount} />
      </div>

      <PartiesFilters
        defaultSearch={query.search ?? ''}
        defaultType={singleType}
        showInactive={showInactive}
      />

      <PartiesTable items={items} emptyAction={<PartyDialog mode="create" />} />

      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        basePath="/finance/parties"
        searchParams={{
          search: query.search,
          type: singleType || undefined,
          inactive: showInactive ? '1' : undefined,
        }}
      />
    </div>
  );
}
