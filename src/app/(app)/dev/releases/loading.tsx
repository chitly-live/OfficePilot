/**
 * `loading.tsx` for `/dev/releases` — skeleton shown while Prisma
 * fetches the release timeline (SPEC §13.4).
 *
 * Mirrors the eventual layout (header + platform-select + stacked
 * release cards) so there's no layout shift when the real content
 * lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_CARDS = 4;

export default function DevReleasesLoading() {
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

      {/* Platform select skeleton */}
      <Skeleton className="h-10 w-full sm:w-64" />

      {/* Release card skeletons */}
      <ol className="space-y-3">
        {Array.from({ length: SKELETON_CARDS }).map((_, idx) => (
          <li
            key={idx}
            className="space-y-3 rounded-lg border bg-card p-6"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-32" />
              </div>
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16 rounded-full" />
                <Skeleton className="h-5 w-16 rounded-full" />
              </div>
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </li>
        ))}
      </ol>
    </div>
  );
}
