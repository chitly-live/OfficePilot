/**
 * `loading.tsx` for `/dev` — skeleton shown while the server page is
 * rendering / Prisma is in flight (SPEC.md §13.4).
 *
 * Mirrors the eventual layout (header + filter bar + 3-column kanban
 * skeleton) so there's no layout shift when the real content lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_COLUMNS = 3;
const SKELETON_CARDS_PER_COLUMN = 3;

export default function DevLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
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

      {/* Filter bar skeleton */}
      <div className="flex flex-wrap gap-3">
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-10 w-44" />
        <Skeleton className="h-10 w-44" />
      </div>

      {/* Kanban skeleton — three columns × three cards. */}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: SKELETON_COLUMNS }).map((_, colIdx) => (
          <div
            key={colIdx}
            className="flex w-full shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3 md:w-72"
          >
            <div className="flex items-center justify-between px-1">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-6" />
            </div>
            <div className="flex flex-col gap-2">
              {Array.from({ length: SKELETON_CARDS_PER_COLUMN }).map(
                (__, cardIdx) => (
                  <Skeleton
                    key={cardIdx}
                    className="h-20 w-full rounded-md"
                  />
                ),
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
