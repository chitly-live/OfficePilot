/**
 * `loading.tsx` for `/social/winners` — skeleton shown while Prisma
 * fetches the winners gallery (SPEC §13.4).
 *
 * Mirrors the header + 6-card responsive grid so there's no layout
 * shift when the real winners land.
 */

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_CARDS = 6;

export default function SocialWinnersLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Winners grid skeleton */}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: SKELETON_CARDS }).map((_, idx) => (
          <div
            key={idx}
            className="space-y-3 rounded-lg border bg-card p-4"
          >
            <Skeleton className="h-40 w-full rounded-md" />
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="h-4 w-2/3" />
            <div className="flex items-center justify-between pt-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-7 w-24" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
