/**
 * `/dev/bugs` — bug inbox (SPEC.md §9.1, §9.2.2).
 *
 * Server Component. List view of `DevTask` rows with `type=BUG`.
 * Sorted by priority desc (URGENT first) then `createdAt` desc so the
 * freshest, highest-priority bugs surface at the top.
 *
 * Columns: title, status, priority, affects version, assignee,
 * reporter, created.
 *
 * URL contract:
 *
 *   /dev/bugs
 *     ?search=
 *     &status=TODO,DOING,DONE                   (comma-separated multi)
 *     &priority=HIGH,URGENT                     (comma-separated multi)
 *     &assigneeId=…                             (or "__unassigned__")
 *     &page=2                                   (pagination)
 *
 * Filters mirror `/dev` so users get the same affordances. The `type`
 * filter is hidden because this surface is scoped to bugs.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Bug } from 'lucide-react';
import { DevTaskType, Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  devTaskListQuerySchema,
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';

import { DevFilters, type AssigneeOption } from '../dev-filters';
import { DevBugsTable } from './bugs-table';

const ASSIGNEE_UNASSIGNED = '__unassigned__';

export const metadata = {
  title: 'Bugs',
};

export const dynamic = 'force-dynamic';

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

interface DevBugsPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function DevBugsPage({
  searchParams,
}: DevBugsPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dev/bugs');
  }

  // Coerce + parse the search params with the same schema as the API.
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
  // Force the type filter to BUG; ignore any user-supplied `type=`.
  delete rawParams.type;

  const parsed = devTaskListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : devTaskListQuerySchema.parse({});

  // Build the where clause: type is locked to BUG.
  const where: Prisma.DevTaskWhereInput = {
    type: DevTaskType.BUG,
  };
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

  const skip = (query.page - 1) * query.pageSize;

  const [items, total, assigneeRows] = await Promise.all([
    prisma.devTask.findMany({
      where,
      select: devTaskPublicProjection,
      orderBy: [
        // Priority first — URGENT bugs always at the top.
        { priority: 'desc' },
        { createdAt: 'desc' },
        { id: 'asc' },
      ],
      skip,
      take: query.pageSize,
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

  const filterAssigneeId = assigneeUnassignedSelected
    ? ASSIGNEE_UNASSIGNED
    : (query.assigneeId ?? '');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Bug inbox"
        subtitle="Triage and track bugs by severity and affects-version."
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/dev">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back to dev</span>
              </Link>
            </Button>
            <Button asChild size="sm">
              <Link href="/dev/new?type=BUG">
                <Bug className="h-4 w-4" aria-hidden="true" />
                <span>Log a bug</span>
              </Link>
            </Button>
          </div>
        }
      />

      <DevFilters
        basePath="/dev/bugs"
        defaultSearch={query.search ?? ''}
        defaultType={[]}
        defaultStatus={query.status ?? []}
        defaultPriority={query.priority ?? []}
        defaultAssigneeId={filterAssigneeId}
        assigneeOptions={assigneeOptions}
        hideType
      />

      <DevBugsTable items={items as DevTaskPublic[]} />

      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        basePath="/dev/bugs"
        searchParams={{
          search: query.search,
          status:
            query.status && query.status.length > 0
              ? query.status.join(',')
              : undefined,
          priority:
            query.priority && query.priority.length > 0
              ? query.priority.join(',')
              : undefined,
          assigneeId: assigneeUnassignedSelected
            ? ASSIGNEE_UNASSIGNED
            : query.assigneeId,
        }}
      />
    </div>
  );
}
