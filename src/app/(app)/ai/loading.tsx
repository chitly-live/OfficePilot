/**
 * `loading.tsx` for `/ai` — skeleton shown while the insights feed is
 * rendering / Prisma is in flight (SPEC.md §13.4).
 *
 * Mirrors the eventual layout (header + scope tabs + 3 insight card
 * skeletons) so there's no layout shift when the real content lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_CARDS = 3;

export default function AILoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton. */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Scope tabs skeleton. */}
      <Skeleton className="h-10 w-full max-w-sm" />

      {/* Insight cards skeleton. */}
      <div className="space-y-3">
        {Array.from({ length: SKELETON_CARDS }).map((_, idx) => (
          <div
            key={idx}
            className="space-y-3 rounded-lg border bg-card p-6 shadow-sm"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-2">
                <Skeleton className="h-5 w-5 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-3 w-12" />
              </div>
              <div className="space-y-1 text-right">
                <Skeleton className="ml-auto h-3 w-24" />
                <Skeleton className="ml-auto h-3 w-40" />
              </div>
            </div>
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-12 w-full rounded-md" />
            <div className="flex items-center justify-between">
              <Skeleton className="h-3 w-20" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-32" />
                <Skeleton className="h-8 w-28" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
