/**
 * `loading.tsx` for `/settings/users` — skeleton shown while the
 * server page is rendering / Prisma is in flight (SPEC §13.4).
 *
 * Mirrors the eventual layout (header + filter bar + 6-row table +
 * pager) so there's no layout shift when the real content lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROWS = 6;
const SKELETON_COLS = 7;

export default function SettingsUsersLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </div>

      {/* Filter bar skeleton */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <Skeleton className="h-10 flex-1" />
        <Skeleton className="h-10 w-full sm:w-40" />
        <Skeleton className="h-10 w-full sm:w-40" />
      </div>

      {/* Table skeleton */}
      <div className="rounded-md border">
        <div className="border-b bg-muted/30 px-4 py-3">
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="divide-y">
          {Array.from({ length: SKELETON_ROWS }).map((_, rowIdx) => (
            <div
              key={rowIdx}
              className="grid grid-cols-7 items-center gap-4 px-4 py-3"
            >
              {Array.from({ length: SKELETON_COLS }).map((__, colIdx) => (
                <Skeleton key={colIdx} className="h-4 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
