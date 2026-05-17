/**
 * `/leads` — leads list (SPEC §6.1, §6.3).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate — anyone without a session is redirected to `/login`.
 *      Both ADMIN and EMPLOYEE see the same global pipeline (SPEC §2.1
 *      "EMPLOYEE: read all, write own"); leads are a shared read.
 *   2. Data — query Prisma directly (NO HTTP round-trip from a Server
 *      Component) using the same `leadPublicProjection` mask the API
 *      uses, and the same filter shape the API parses via
 *      `leadListQuerySchema`. URL-driven so the back button and deep
 *      links work as expected.
 *   3. Owner select feed — the filter bar's owner dropdown is populated
 *      from the `User` list on the server so the client doesn't have
 *      to spend an extra round-trip on a tiny lookup.
 *   4. Render — `PageHeader` (with "New lead" + "Import CSV" CTAs) +
 *      `LeadsFilters` (client) + `LeadsTable` (client) + `Pagination`.
 *
 * URL contract:
 *
 *   /leads
 *     ?search=
 *     &status=NEW,CONTACTED,…           (comma-separated multi)
 *     &source=WHATSAPP,WEBSITE,…        (comma-separated multi)
 *     &priority=HIGH,URGENT             (comma-separated multi)
 *     &ownerId=…
 *     &tag=hot
 *     &dateFrom=2026-01-01
 *     &dateTo=2026-01-31
 *     &page=2
 *
 * The Kanban view toggles via `?view=kanban` (SPEC §6.2.2). When
 * `view=kanban`:
 *
 *   • Filters still apply (status, source, owner, …) so users can
 *     narrow the pipeline before drag-dropping.
 *   • Pagination is bypassed — a kanban surface that only shows
 *     half the pipeline at a time is useless. Instead we cap the
 *     fetched set at the Lead API's max page size (200 rows) so
 *     extreme pipelines still render in finite time. If a tenant
 *     ever exceeds that, we'll add a "more results" hint; for now
 *     the cap is well above any realistic per-day pipeline.
 *   • The status filter is intentionally still honored — a user can
 *     hide LOST/CONVERTED on the kanban if they only want to focus
 *     on active stages.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { LayoutGrid, Plus, Table2, Upload } from 'lucide-react';
import { Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  leadListQuerySchema,
  leadPublicProjection,
  type LeadPublic,
} from '@/lib/schemas/leads';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';
import { cn } from '@/lib/utils';

import { LeadsFilters, type OwnerOption } from './leads-filters';
import { LeadsKanban } from './leads-kanban';
import { LeadsTable } from './leads-table';

/** SPEC §6.3: max page size on the Lead list. Re-declared here as a
 *  constant so the kanban-mode cap is grep-able. */
const KANBAN_MAX_LEADS = 200;

/**
 * Recognised values for `?view=`. Anything else (including missing)
 * falls back to the table view.
 */
type LeadsView = 'table' | 'kanban';
const VIEW_VALUES: readonly LeadsView[] = ['table', 'kanban'];

export const metadata = {
  title: 'Leads',
};

// Always render fresh — the list reflects live DB state.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Search-param coercion
// ---------------------------------------------------------------------------

/**
 * Next.js 14 page props receive `searchParams` as
 * `{ [key: string]: string | string[] | undefined }`. For multi-value
 * filters (status, source, priority) we want the comma-joined first
 * value if a single string is sent, but if Next.js gives us an array
 * (rare but possible if the same key is repeated) we join it on
 * commas so `leadListQuerySchema`'s `multiEnum` parser can handle it
 * uniformly.
 */
function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(',');
    return joined.length > 0 ? joined : undefined;
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface LeadsPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function LeadsPage({ searchParams }: LeadsPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/leads');
  }

  // ------------------------------------------------------------------
  // 2. Parse + validate the search params with the same schema the
  //    API route uses, so client and server agree on filter coercion.
  //    `view` is parsed separately because it isn't part of the API
  //    contract — it's a pure client navigation concern.
  // ------------------------------------------------------------------
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // Resolve the view first (defaults to table). We strip it from the
  // params handed to the API schema below — it isn't a list filter.
  const rawView = rawParams.view;
  const view: LeadsView =
    rawView && (VIEW_VALUES as readonly string[]).includes(rawView)
      ? (rawView as LeadsView)
      : 'table';
  delete rawParams.view;

  // `safeParse` so an invalid query string falls back to defaults
  // rather than 500ing the page. We surface the errors silently —
  // bad URLs are user-correctable.
  const parsed = leadListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : leadListQuerySchema.parse({}); // defaults only

  // ------------------------------------------------------------------
  // 3. Build the Prisma where clause — identical shape to the API
  //    route in `src/app/api/leads/route.ts`.
  // ------------------------------------------------------------------
  const where: Prisma.LeadWhereInput = {};

  if (query.status && query.status.length > 0) {
    where.status = { in: query.status };
  }
  if (query.source && query.source.length > 0) {
    where.source = { in: query.source };
  }
  if (query.priority && query.priority.length > 0) {
    where.priority = { in: query.priority };
  }
  if (query.ownerId !== undefined) {
    where.ownerId = query.ownerId;
  }
  if (query.tag !== undefined) {
    where.tags = { has: query.tag };
  }
  if (query.dateFrom !== undefined || query.dateTo !== undefined) {
    where.createdAt = {
      ...(query.dateFrom !== undefined ? { gte: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { lte: query.dateTo } : {}),
    };
  }
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
      { phone: { contains: query.search, mode: 'insensitive' } },
      { company: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  // Sort column mapping mirrors the API. Default is `createdAt desc`.
  const SORT_COLUMN_BY_KEY = {
    created: 'createdAt',
    updated: 'updatedAt',
    nextFollowUp: 'nextFollowUpAt',
    value: 'value',
  } as const;
  const sortColumn = SORT_COLUMN_BY_KEY[query.sortBy];
  const orderBy: Prisma.LeadOrderByWithRelationInput[] = [
    { [sortColumn]: query.sortDir } as Prisma.LeadOrderByWithRelationInput,
    // Tie-breaker so paging is deterministic.
    { id: 'asc' },
  ];

  // In kanban mode, pagination is bypassed (a partial pipeline is
  // useless on a drag-drop board). We cap at `KANBAN_MAX_LEADS` so a
  // pathological dataset can't OOM the page; the filter bar is the
  // user's escape hatch when they bump that ceiling.
  const isKanban = view === 'kanban';
  const skip = isKanban ? 0 : (query.page - 1) * query.pageSize;
  const take = isKanban ? KANBAN_MAX_LEADS : query.pageSize;

  // ------------------------------------------------------------------
  // 4. Run the list, count, and owner lookup in parallel. The owner
  //    list is bounded (active users only, capped at 200) — way
  //    smaller than the lead set and a tiny extra round-trip.
  // ------------------------------------------------------------------
  const [items, total, ownerRows] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: leadPublicProjection,
      orderBy,
      skip,
      take,
    }),
    prisma.lead.count({ where }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
  ]);

  const ownerOptions: OwnerOption[] = ownerRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  // ------------------------------------------------------------------
  // 5. Build the href helper for Pagination + the view toggle. We
  //    rebuild the query string from the same `query` object so all
  //    current filters survive a page change OR a view switch.
  // ------------------------------------------------------------------
  const buildHref = (overrides: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.status && query.status.length > 0) {
      params.set('status', query.status.join(','));
    }
    if (query.source && query.source.length > 0) {
      params.set('source', query.source.join(','));
    }
    if (query.priority && query.priority.length > 0) {
      params.set('priority', query.priority.join(','));
    }
    if (query.ownerId !== undefined) params.set('ownerId', query.ownerId);
    if (query.tag !== undefined) params.set('tag', query.tag);
    if (query.dateFrom !== undefined) {
      params.set('dateFrom', query.dateFrom.toISOString().slice(0, 10));
    }
    if (query.dateTo !== undefined) {
      params.set('dateTo', query.dateTo.toISOString().slice(0, 10));
    }
    if (query.page !== 1) params.set('page', String(query.page));
    // Preserve the active view by default — overrides may flip it.
    if (view !== 'table') params.set('view', view);

    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined || value === '') {
        params.delete(key);
      } else {
        params.set(key, value);
      }
    }
    const qs = params.toString();
    return qs ? `/leads?${qs}` : '/leads';
  };

  // Hrefs for the Table | Kanban toggle. Switching to kanban drops
  // the `page` param (kanban has no pagination); switching back to
  // table keeps filters but resets to page 1 so the user sees the
  // newest matches first.
  const tableHref = buildHref({ view: undefined, page: undefined });
  const kanbanHref = buildHref({ view: 'kanban', page: undefined });

  // Default values for the filter bar.
  const defaultDateFrom = query.dateFrom
    ? query.dateFrom.toISOString().slice(0, 10)
    : '';
  const defaultDateTo = query.dateTo
    ? query.dateTo.toISOString().slice(0, 10)
    : '';

  return (
    <div className="space-y-6">
      <PageHeader
        title="Leads"
        subtitle="Pipeline of customer inquiries — capture, triage, and convert."
        actions={
          <div className="flex items-center gap-2">
            {/*
             * View toggle (table ↔ kanban). Implemented as anchor
             * links rather than a stateful Tabs component so the
             * choice is preserved in the URL — copy/paste-able and
             * back-button-friendly. Filters survive the switch via
             * `buildHref`.
             */}
            <div
              role="tablist"
              aria-label="View"
              className="inline-flex items-center rounded-md border bg-background p-0.5 text-sm"
            >
              <Link
                href={tableHref}
                role="tab"
                aria-selected={view === 'table'}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                  view === 'table'
                    ? 'bg-muted text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Table2 className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Table</span>
              </Link>
              <Link
                href={kanbanHref}
                role="tab"
                aria-selected={view === 'kanban'}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs font-medium transition-colors',
                  view === 'kanban'
                    ? 'bg-muted text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Kanban</span>
              </Link>
            </div>

            <Button asChild variant="outline" size="sm">
              <Link href="/leads/import">
                <Upload className="h-4 w-4" aria-hidden="true" />
                <span>Import CSV</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/leads/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>New lead</span>
              </Link>
            </Button>
          </div>
        }
      />

      <LeadsFilters
        defaultSearch={query.search ?? ''}
        defaultStatus={query.status ?? []}
        defaultSource={query.source ?? []}
        defaultPriority={query.priority ?? []}
        defaultOwnerId={query.ownerId ?? ''}
        defaultTag={query.tag ?? ''}
        defaultDateFrom={defaultDateFrom}
        defaultDateTo={defaultDateTo}
        ownerOptions={ownerOptions}
      />

      {isKanban ? (
        <>
          <LeadsKanban items={items as LeadPublic[]} />
          {total > items.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {items.length} of {total} leads. Narrow
              with filters to see the rest.
            </p>
          ) : null}
        </>
      ) : (
        <>
          <LeadsTable items={items as LeadPublic[]} />
          <Pagination
            page={query.page}
            pageSize={query.pageSize}
            total={total}
            basePath="/leads"
            searchParams={{
              search: query.search,
              status:
                query.status && query.status.length > 0
                  ? query.status.join(',')
                  : undefined,
              source:
                query.source && query.source.length > 0
                  ? query.source.join(',')
                  : undefined,
              priority:
                query.priority && query.priority.length > 0
                  ? query.priority.join(',')
                  : undefined,
              ownerId: query.ownerId,
              tag: query.tag,
              dateFrom:
                query.dateFrom !== undefined
                  ? query.dateFrom.toISOString().slice(0, 10)
                  : undefined,
              dateTo:
                query.dateTo !== undefined
                  ? query.dateTo.toISOString().slice(0, 10)
                  : undefined,
              view: view !== 'table' ? view : undefined,
            }}
          />
        </>
      )}
    </div>
  );
}
