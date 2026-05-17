/**
 * `loading.tsx` for `/dev/roadmap` — skeleton shown while Prisma
 * fetches the roadmap (SPEC §13.4).
 *
 * Mirrors the eventual layout (header + 8 week-column skeletons in a
 * horizontal scroller) so there's no layout shift when the real
 * content lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_COLUMNS = 8;
const SKELETON_CARDS_PER_COLUMN = 2;

export default function DevRoadmapLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Week-column skeletons */}
      <div className="overflow-x-auto pb-2">
        <ol className="flex gap-3">
          {Array.from({ length: SKELETON_COLUMNS }).map((_, colIdx) => (
            <li
              key={colIdx}
              className="flex w-72 shrink-0 flex-col gap-2 rounded-lg border bg-muted/30 p-3"
            >
              <div className="flex items-center justify-between px-1">
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-6" />
              </div>
              <Skeleton className="h-3 w-32" />
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
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
