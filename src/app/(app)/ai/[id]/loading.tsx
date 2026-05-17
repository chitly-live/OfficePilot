/**
 * `loading.tsx` for `/ai/[id]` — skeleton shown while Prisma
 * fetches the insight detail (SPEC §13.4).
 *
 * Mirrors the eventual layout (header + 4 KPI cards + summary card +
 * raw-data card) so there's no layout shift when the real content
 * lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const STAT_CARDS = 4;

export default function AIInsightDetailLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-44" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28" />
          <Skeleton className="h-9 w-32" />
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: STAT_CARDS }).map((_, idx) => (
          <Skeleton key={idx} className="h-24 w-full" />
        ))}
      </div>

      {/* Summary card */}
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-20 w-full rounded-md" />
      </div>

      {/* Raw data card */}
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-64 w-full rounded-md" />
      </div>
    </div>
  );
}
