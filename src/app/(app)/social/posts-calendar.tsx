'use client';

/**
 * SocialPostsCalendar — month-grid calendar for `/social` (SPEC.md
 * §8.1, §8.2.1).
 *
 * Renders a 6-row × 7-col month grid with posts placed on the date
 * cell that matches their `scheduledAt` (or `publishedAt` when
 * scheduledAt is null — a published post that was created without a
 * schedule still belongs on the day it went live). Each pill is
 * coloured by platform and links to the post detail page.
 *
 * Keep this client-side: month navigation is purely visual (no extra
 * Prisma calls), so the parent server page hands us the full set of
 * scheduled-or-published posts inside the visible month and we
 * arrange them.
 *
 * Acceptance criterion §8.4: "Schedule a post for tomorrow → appears
 * on calendar at correct date" — covered by placing posts via their
 * `scheduledAt` day in the user's local time zone.
 */

import * as React from 'react';
import Link from 'next/link';
import { addMonths, format, isSameDay, startOfDay } from 'date-fns';
import { ChevronLeft, ChevronRight, Star } from 'lucide-react';
import type { SocialPlatform } from '@prisma/client';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SocialPostPublic } from '@/lib/schemas/social';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SocialPostsCalendarProps {
  /** Posts to render. The parent page is responsible for fetching the
   *  set inside the visible month. */
  items: SocialPostPublic[];
  /**
   * The month to render. Any Date inside the desired month works —
   * we normalise to the first of the month internally. Defaults to
   * the current month.
   */
  initialMonth?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** First day of the month containing `date`, at local midnight. */
function startOfMonthLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

/**
 * Pick the first Sunday on or before `date`. The grid always starts
 * on Sunday so the same `weekDayLabels` ordering applies regardless
 * of which weekday the 1st falls on. We use the local time zone
 * because a post scheduled for "Tuesday at 8am" should land on the
 * Tuesday cell in the viewer's calendar.
 */
function gridStart(monthStart: Date): Date {
  const date = new Date(monthStart);
  date.setDate(date.getDate() - date.getDay());
  return startOfDay(date);
}

/**
 * 6 weeks × 7 days = 42 cells. Six rows is enough to cover any
 * Gregorian month (the worst case is a 31-day month starting on
 * Saturday).
 */
const GRID_CELLS = 42;

const WEEKDAY_LABELS = [
  'Sun',
  'Mon',
  'Tue',
  'Wed',
  'Thu',
  'Fri',
  'Sat',
] as const;

/**
 * Tailwind class fragments for each platform's pill. Picked from the
 * brand-adjacent palette so the calendar is glanceable even at a
 * 5-event density per cell.
 *
 * SPEC.md §8.1 — "calendar view (month grid) with posts colored by
 * platform".
 */
const PLATFORM_CLASSES: Record<SocialPlatform, string> = {
  INSTAGRAM:
    'bg-pink-500/15 text-pink-700 dark:text-pink-300 border-pink-500/40',
  FACEBOOK:
    'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/40',
  TWITTER:
    'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/40',
  LINKEDIN:
    'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 border-indigo-500/40',
  YOUTUBE:
    'bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/40',
  THREADS:
    'bg-zinc-500/15 text-zinc-700 dark:text-zinc-300 border-zinc-500/40',
};

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

/**
 * Pick the meaningful date for placing a post on the calendar.
 * Priority: `scheduledAt` > `publishedAt` > `createdAt`. This way:
 *   • Drafts with a schedule appear on the planned day.
 *   • Published-but-not-scheduled posts (rare — created and pushed
 *     same day) still show up on the publish day.
 *   • Pure drafts with neither timestamp set fall back to the
 *     creation day so the calendar isn't silent on them.
 */
function placementDate(post: SocialPostPublic): Date {
  if (post.scheduledAt) return new Date(post.scheduledAt);
  if (post.publishedAt) return new Date(post.publishedAt);
  return new Date(post.createdAt);
}

/** Truncate a caption to fit a calendar pill. */
function pillCaption(caption: string): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  return collapsed.length > 32
    ? `${collapsed.slice(0, 32)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** Maximum number of pills to render per cell before showing "+N more". */
const MAX_PILLS_PER_CELL = 3;

export function SocialPostsCalendar({
  items,
  initialMonth,
}: SocialPostsCalendarProps) {
  const [monthAnchor, setMonthAnchor] = React.useState<Date>(() =>
    startOfMonthLocal(initialMonth ?? new Date()),
  );

  // Re-bin posts to date keys on every render — `items` length is
  // capped by the parent so the cost is negligible. Using a string
  // key avoids per-cell `isSameDay` work in the inner loop.
  const itemsByDay = React.useMemo(() => {
    const map = new Map<string, SocialPostPublic[]>();
    for (const post of items) {
      const date = placementDate(post);
      const key = format(date, 'yyyy-MM-dd');
      const bucket = map.get(key);
      if (bucket) {
        bucket.push(post);
      } else {
        map.set(key, [post]);
      }
    }
    // Sort each bucket so pills inside one cell render in a stable
    // order (scheduled time ascending, then id).
    for (const bucket of map.values()) {
      bucket.sort((a, b) => {
        const ta = placementDate(a).getTime();
        const tb = placementDate(b).getTime();
        if (ta !== tb) return ta - tb;
        return a.id.localeCompare(b.id);
      });
    }
    return map;
  }, [items]);

  const today = startOfDay(new Date());
  const start = gridStart(monthAnchor);
  const cells: Date[] = React.useMemo(() => {
    const result: Date[] = [];
    for (let i = 0; i < GRID_CELLS; i += 1) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      result.push(day);
    }
    return result;
  }, [start]);

  return (
    <div className="space-y-3">
      {/* Month navigation. */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-foreground">
          {format(monthAnchor, 'MMMM yyyy')}
        </h2>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Previous month"
            onClick={() =>
              setMonthAnchor((prev) => addMonths(prev, -1))
            }
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setMonthAnchor(startOfMonthLocal(new Date()))}
          >
            Today
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Next month"
            onClick={() => setMonthAnchor((prev) => addMonths(prev, 1))}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {/* Weekday header. */}
      <div className="grid grid-cols-7 gap-px text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {WEEKDAY_LABELS.map((label) => (
          <div key={label} className="px-2 py-1">
            {label}
          </div>
        ))}
      </div>

      {/* Day grid. */}
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border">
        {cells.map((day) => {
          const inCurrentMonth = day.getMonth() === monthAnchor.getMonth();
          const isToday = isSameDay(day, today);
          const dayKey = format(day, 'yyyy-MM-dd');
          const dayPosts = itemsByDay.get(dayKey) ?? [];
          const visiblePosts = dayPosts.slice(0, MAX_PILLS_PER_CELL);
          const overflow = dayPosts.length - visiblePosts.length;

          return (
            <div
              key={dayKey}
              className={cn(
                'min-h-24 bg-card p-1.5',
                !inCurrentMonth && 'bg-muted/30',
              )}
            >
              <div
                className={cn(
                  'mb-1 flex items-center justify-between text-xs',
                  inCurrentMonth
                    ? 'text-foreground'
                    : 'text-muted-foreground',
                )}
              >
                <span
                  className={cn(
                    'inline-flex h-5 w-5 items-center justify-center rounded-full font-medium tabular-nums',
                    isToday &&
                      'bg-primary text-primary-foreground',
                  )}
                >
                  {format(day, 'd')}
                </span>
                {dayPosts.length > 0 ? (
                  <span className="text-[10px] font-medium text-muted-foreground">
                    {dayPosts.length}
                  </span>
                ) : null}
              </div>

              <ul className="space-y-1">
                {visiblePosts.map((post) => (
                  <li key={post.id}>
                    <Link
                      href={`/social/${post.id}`}
                      title={`${PLATFORM_LABELS[post.platform]} · ${post.caption}`}
                      className={cn(
                        'flex items-center gap-1 truncate rounded border px-1.5 py-0.5 text-[11px] font-medium leading-tight hover:underline',
                        PLATFORM_CLASSES[post.platform],
                      )}
                    >
                      {post.isWinner ? (
                        <Star
                          className="h-3 w-3 shrink-0 fill-current"
                          aria-hidden="true"
                        />
                      ) : null}
                      <span className="truncate">
                        {pillCaption(post.caption)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>

              {overflow > 0 ? (
                <div className="mt-1 text-[10px] text-muted-foreground">
                  +{overflow} more
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {/* Platform legend. */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {(Object.keys(PLATFORM_CLASSES) as SocialPlatform[]).map(
          (platform) => (
            <span
              key={platform}
              className="inline-flex items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className={cn(
                  'inline-block h-2.5 w-2.5 rounded-sm border',
                  PLATFORM_CLASSES[platform],
                )}
              />
              {PLATFORM_LABELS[platform]}
            </span>
          ),
        )}
      </div>
    </div>
  );
}
