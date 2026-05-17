/**
 * `/dev/roadmap` — 8-week target-week roadmap (SPEC.md §9.1.4,
 * §9.2.4, §9.4 "Roadmap shows tasks grouped by week, 8 columns
 * visible").
 *
 * Server Component. Read-only for v1 (the brief; future iteration
 * may add drag-drop to re-target). Renders a horizontally-scrolling
 * grid of week columns starting from the Monday of the current week.
 *
 * Window:
 *   • The first column is the Monday of the *current* week (the
 *     Monday on or before "now").
 *   • Default 8 columns; `?weeks=` overrides up to 52 (matches the
 *     API's `devRoadmapQuerySchema`).
 *   • Tasks without `targetWeek` are excluded — the roadmap surface
 *     is scoped to "what are we doing in the next N weeks".
 *   • RELEASE entries are excluded (they live on `/dev/releases`).
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Calendar } from 'lucide-react';
import { DevTaskType, type Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  devTaskPublicProjection,
  type DevTaskPublic,
} from '@/lib/schemas/dev';

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { EmptyState } from '@/components/shared/EmptyState';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

const DEFAULT_WEEKS = 8;
const MIN_WEEKS = 1;
const MAX_WEEKS = 52;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const metadata = {
  title: 'Roadmap',
};

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Date helpers (mirror the API in src/app/api/dev/roadmap/route.ts)
// ---------------------------------------------------------------------------

/**
 * Return the Monday at 00:00 UTC on or before `now`. Pure helper —
 * makes the bucket math testable without freezing the system clock.
 */
function startOfIsoWeek(now: Date): Date {
  const utcMidnight = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      0,
      0,
      0,
      0,
    ),
  );
  const day = utcMidnight.getUTCDay();
  const shift = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - shift);
  return utcMidnight;
}

function addUtcDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

function formatWeekHeading(monday: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
  }).format(monday);
}

function formatWeekRange(monday: Date): string {
  const sunday = addUtcDays(monday, 6);
  const start = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
  }).format(monday);
  const end = new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
  }).format(sunday);
  return `${start} – ${end}`;
}

function getInitials(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromFallback = fallback.trim()[0];
  return (fromFallback ?? '?').toUpperCase();
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

interface DevRoadmapPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function DevRoadmapPage({
  searchParams,
}: DevRoadmapPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dev/roadmap');
  }

  // Resolve `?weeks=`. Clamp to [MIN_WEEKS, MAX_WEEKS]; default 8.
  const rawWeeks = coerceParam(searchParams?.weeks);
  const parsedWeeks = rawWeeks ? Number(rawWeeks) : DEFAULT_WEEKS;
  const weeks = Number.isFinite(parsedWeeks)
    ? Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, Math.floor(parsedWeeks)))
    : DEFAULT_WEEKS;

  const firstMonday = startOfIsoWeek(new Date());
  const lastMondayExclusive = addUtcDays(firstMonday, weeks * 7);

  const where: Prisma.DevTaskWhereInput = {
    targetWeek: {
      gte: firstMonday,
      lt: lastMondayExclusive,
    },
    // Releases live on /dev/releases — exclude them from the roadmap.
    type: {
      in: [DevTaskType.FEATURE, DevTaskType.BUG, DevTaskType.CHORE],
    },
  };

  const tasks = (await prisma.devTask.findMany({
    where,
    select: devTaskPublicProjection,
    orderBy: [
      { priority: 'desc' },
      { createdAt: 'desc' },
      { id: 'asc' },
    ],
  })) as unknown as DevTaskPublic[];

  // Pre-build the buckets so empty weeks still render as columns.
  const buckets: Array<{
    weekStart: Date;
    tasks: DevTaskPublic[];
  }> = [];
  for (let i = 0; i < weeks; i += 1) {
    buckets.push({ weekStart: addUtcDays(firstMonday, i * 7), tasks: [] });
  }
  for (const task of tasks) {
    if (!task.targetWeek) continue;
    const targetMs = startOfIsoWeek(
      task.targetWeek as unknown as Date,
    ).getTime();
    const idx = Math.floor(
      (targetMs - firstMonday.getTime()) / (MS_PER_DAY * 7),
    );
    if (idx >= 0 && idx < buckets.length) {
      buckets[idx]!.tasks.push(task);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Roadmap"
        subtitle={`Tasks grouped by target week — ${weeks}-week horizon, read-only.`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dev">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to dev</span>
            </Link>
          </Button>
        }
      />

      {tasks.length === 0 ? (
        <EmptyState
          icon={Calendar}
          title="No scheduled work"
          description="Set a target week on a task to surface it here."
          action={
            <Button asChild size="sm">
              <Link href="/dev/new">New task</Link>
            </Button>
          }
        />
      ) : null}

      <div className="overflow-x-auto pb-2">
        <ol
          className="flex gap-3"
          aria-label={`Roadmap for the next ${weeks} weeks`}
        >
          {buckets.map((bucket, idx) => (
            <RoadmapColumn
              key={bucket.weekStart.toISOString()}
              weekStart={bucket.weekStart}
              tasks={bucket.tasks}
              isCurrentWeek={idx === 0}
            />
          ))}
        </ol>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoadmapColumn
// ---------------------------------------------------------------------------

function RoadmapColumn({
  weekStart,
  tasks,
  isCurrentWeek,
}: {
  weekStart: Date;
  tasks: DevTaskPublic[];
  isCurrentWeek: boolean;
}) {
  return (
    <li className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="space-y-0.5 px-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Week of {formatWeekHeading(weekStart)}
            {isCurrentWeek ? (
              <span className="ml-2 inline-flex items-center rounded-full bg-brand-50 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
                This week
              </span>
            ) : null}
          </h3>
          <span className="text-xs text-muted-foreground">{tasks.length}</span>
        </div>
        <p className="text-[11px] text-muted-foreground">
          {formatWeekRange(weekStart)}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        {tasks.length === 0 ? (
          <div className="rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            Nothing scheduled
          </div>
        ) : (
          tasks.map((task) => <RoadmapCard key={task.id} task={task} />)
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// RoadmapCard
// ---------------------------------------------------------------------------

const TYPE_TONE = {
  FEATURE: 'green',
  BUG: 'red',
  CHORE: 'neutral',
  RELEASE: 'blue',
} as const;

const TYPE_LABEL = {
  FEATURE: 'Feature',
  BUG: 'Bug',
  CHORE: 'Chore',
  RELEASE: 'Release',
} as const;

function RoadmapCard({ task }: { task: DevTaskPublic }) {
  const assignee = task.assignee;
  return (
    <Link
      href={`/dev`}
      className={cn(
        'block rounded-md border bg-card p-3 text-sm shadow-sm',
        'hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusBadge
              status={task.type}
              tone={TYPE_TONE[task.type]}
              label={TYPE_LABEL[task.type]}
              className="shrink-0"
            />
            <StatusBadge status={task.status} className="shrink-0" />
          </div>
          <div className="truncate text-sm font-medium text-foreground">
            {task.title}
          </div>
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {assignee ? (
            <>
              <Avatar className="h-5 w-5">
                {assignee.avatarUrl ? (
                  <AvatarImage src={assignee.avatarUrl} alt={assignee.name} />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-[8px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(assignee.name, assignee.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-xs text-muted-foreground">
                {assignee.name || assignee.email}
              </span>
            </>
          ) : (
            <span className="text-xs italic text-muted-foreground">
              Unassigned
            </span>
          )}
        </div>
        <StatusBadge status={task.priority} className="shrink-0" />
      </div>
    </Link>
  );
}
