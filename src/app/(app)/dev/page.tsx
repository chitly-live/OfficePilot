/**
 * `/dev` — Dev Tracking kanban (SPEC.md §9.1, §9.2.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate — anyone without a session is redirected to `/login`.
 *      Both ADMIN and EMPLOYEE see the same global board (SPEC.md §2.1
 *      "EMPLOYEE: read all, write own"); dev is a shared workspace.
 *   2. Data — query Prisma directly (NO HTTP round-trip from a Server
 *      Component) using the same `devTaskPublicProjection` mask the
 *      API uses, and the same filter shape the API parses via
 *      `devTaskListQuerySchema`. URL-driven so the back button and
 *      deep links work as expected.
 *   3. Assignee select feed — populated server-side from active Users.
 *   4. Render — `PageHeader` (with "New task" CTA + sub-page links)
 *      + `DevFilters` (client) + `DevKanban` (client, drag-drop).
 *
 * URL contract:
 *
 *   /dev
 *     ?search=
 *     &type=FEATURE,BUG,…           (comma-separated multi)
 *     &status=TODO,DOING,DONE       (comma-separated multi — usually
 *                                    omitted because the kanban
 *                                    surfaces all three columns)
 *     &priority=HIGH,URGENT         (comma-separated multi)
 *     &assigneeId=…                 (or "__unassigned__")
 *
 * **Why no pagination?** A kanban surface that shows half the work
 * is useless. We cap the fetched set at the API's max page size (200
 * rows) so extreme backlogs still render in finite time. A "showing
 * first N of M" hint nudges users to filter when they hit that cap.
 *
 * **Why type=RELEASE excluded by default?** The kanban is for
 * in-flight engineering work (SPEC.md §9.1 "Kanban board (TODO /
 * DOING / DONE) for current week"). Release log entries are a
 * separate timeline rendered on `/dev/releases`. Users who want to
 * see them on the kanban can opt in via the type filter.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Bug, Calendar, ListChecks, Plus, Rocket } from 'lucide-react';
import { DevTaskType, Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  devTaskListQuerySchema,
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';

import { DevFilters, type AssigneeOption } from './dev-filters';
import { DevKanban } from './dev-kanban';

/** Sentinel value for the "Unassigned" assignee filter — translated
 *  here into `where.assigneeId = null`. */
const ASSIGNEE_UNASSIGNED = '__unassigned__';

/** SPEC.md §6.3 max page size, reused as the kanban cap. */
const KANBAN_MAX_TASKS = 200;

export const metadata = {
  title: 'Dev',
};

// Always render fresh — the board reflects live DB state.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Search-param coercion
// ---------------------------------------------------------------------------

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

interface DevPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function DevPage({ searchParams }: DevPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dev');
  }

  // ------------------------------------------------------------------
  // 2. Parse search params. We pull `assigneeId` out separately
  //    because the "__unassigned__" sentinel isn't part of the API's
  //    schema (the API accepts a real cuid only); we translate it
  //    into a `null` where clause locally.
  // ------------------------------------------------------------------
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  const rawAssigneeId = rawParams.assigneeId;
  const assigneeUnassignedSelected = rawAssigneeId === ASSIGNEE_UNASSIGNED;
  if (assigneeUnassignedSelected) {
    delete rawParams.assigneeId;
  }

  const parsed = devTaskListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : devTaskListQuerySchema.parse({});

  // ------------------------------------------------------------------
  // 3. Build the Prisma where clause — identical shape to the API
  //    route in `src/app/api/dev/tasks/route.ts` plus the kanban-
  //    specific exclusion of RELEASE rows when the user hasn't
  //    explicitly asked for them.
  // ------------------------------------------------------------------
  const where: Prisma.DevTaskWhereInput = {};

  if (query.type && query.type.length > 0) {
    where.type = { in: query.type };
  } else {
    // Default kanban view excludes releases (SPEC.md §9.1 — releases
    // live on `/dev/releases`). Users can opt in via the Type filter.
    where.type = { in: [DevTaskType.FEATURE, DevTaskType.BUG, DevTaskType.CHORE] };
  }
  if (query.status && query.status.length > 0) {
    where.status = { in: query.status };
  }
  if (query.priority && query.priority.length > 0) {
    where.priority = { in: query.priority };
  }
  if (assigneeUnassignedSelected) {
    where.assigneeId = null;
  } else if (query.assigneeId !== undefined) {
    where.assigneeId = query.assigneeId;
  }
  if (query.search) {
    where.OR = [
      { title: { contains: query.search, mode: 'insensitive' } },
      { description: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  // ------------------------------------------------------------------
  // 4. Run the list, count, and assignee lookup in parallel.
  // ------------------------------------------------------------------
  const [items, total, assigneeRows] = await Promise.all([
    prisma.devTask.findMany({
      where,
      select: devTaskPublicProjection,
      // Order: priority desc (URGENT first), then most recently
      // updated so the top of each column shows the freshest work.
      orderBy: [
        { priority: 'desc' },
        { updatedAt: 'desc' },
        { id: 'asc' },
      ],
      take: KANBAN_MAX_TASKS,
    }),
    prisma.devTask.count({ where }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
  ]);

  const assigneeOptions: AssigneeOption[] = assigneeRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  // The filter's "assigneeId" stays "" → all unless the unassigned
  // sentinel was selected, in which case we round-trip the sentinel
  // back to the filter so it stays selected after a refresh.
  const filterAssigneeId = assigneeUnassignedSelected
    ? ASSIGNEE_UNASSIGNED
    : (query.assigneeId ?? '');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dev"
        subtitle="Kanban for in-flight engineering work — features, bugs, and chores."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/dev/bugs">
                <Bug className="h-4 w-4" aria-hidden="true" />
                <span>Bugs</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dev/releases">
                <Rocket className="h-4 w-4" aria-hidden="true" />
                <span>Releases</span>
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link href="/dev/roadmap">
                <Calendar className="h-4 w-4" aria-hidden="true" />
                <span>Roadmap</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/dev/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>New task</span>
              </Link>
            </Button>
          </div>
        }
      />

      <DevFilters
        basePath="/dev"
        defaultSearch={query.search ?? ''}
        defaultType={query.type ?? []}
        defaultStatus={query.status ?? []}
        defaultPriority={query.priority ?? []}
        defaultAssigneeId={filterAssigneeId}
        assigneeOptions={assigneeOptions}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="No tasks yet"
          description="Add your first task to start tracking what the team is shipping."
          action={
            <Button asChild size="sm">
              <Link href="/dev/new">
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>New task</span>
              </Link>
            </Button>
          }
        />
      ) : (
        <>
          <DevKanban items={items as DevTaskPublic[]} />
          {total > items.length ? (
            <p className="text-xs text-muted-foreground">
              Showing the first {items.length} of {total} tasks. Narrow
              with filters to see the rest.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
