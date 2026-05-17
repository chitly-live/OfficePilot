/**
 * `loading.tsx` for `/social` — skeleton shown while the server page
 * renders / Prisma is in flight (SPEC.md §13.4).
 *
 * Mirrors the eventual layout (header + view toggle + filter bar +
 * calendar/table) so there's no layout shift when the real content
 * lands. We render a calendar-grid-shaped skeleton because that's
 * the default view.
 */

import { Skeleton } from '@/components/ui/skeleton';

const CALENDAR_CELLS = 42;

export default function SocialLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* View toggle */}
      <Skeleton className="h-9 w-44" />

      {/* Filter bar */}
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-full sm:w-56" />
          <Skeleton className="h-10 w-full sm:w-44" />
        </div>
        <div className="flex flex-wrap gap-3">
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-10 w-44" />
          <Skeleton className="h-10 w-44" />
        </div>
      </div>

      {/* Calendar grid */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Skeleton className="h-6 w-40" />
          <div className="flex gap-1">
            <Skeleton className="h-9 w-9" />
            <Skeleton className="h-9 w-16" />
            <Skeleton className="h-9 w-9" />
          </div>
        </div>
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-md border bg-border">
          {Array.from({ length: CALENDAR_CELLS }).map((_, idx) => (
            <Skeleton key={idx} className="h-24 rounded-none bg-card" />
          ))}
        </div>
      </div>
    </div>
  );
}
