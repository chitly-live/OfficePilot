/**
 * `loading.tsx` for `/social/[id]` — skeleton shown while Prisma
 * fetches the post + activity (SPEC.md §13.4).
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function SocialPostDetailLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-72" />
          <Skeleton className="h-4 w-64" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
        </div>
      </div>

      {/* Engagement metrics row */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }).map((_, idx) => (
          <Skeleton key={idx} className="h-24 w-full" />
        ))}
      </div>

      {/* Preview card */}
      <div className="space-y-3 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/4" />
      </div>

      {/* Tabs body */}
      <div className="space-y-4">
        <Skeleton className="h-10 w-48" />
        <div className="space-y-4 rounded-lg border bg-card p-6">
          <Skeleton className="h-5 w-40" />
          <div className="grid gap-4 sm:grid-cols-2">
            {Array.from({ length: 6 }).map((_, idx) => (
              <Skeleton key={idx} className="h-10 w-full" />
            ))}
          </div>
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    </div>
  );
}
