/**
 * `loading.tsx` for `/leads/[id]` — skeleton shown while Prisma
 * fetches the lead + notes + activity (SPEC §13.4).
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function LeadDetailLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Tabs body */}
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-10 w-72" />
          <div className="rounded-lg border bg-card p-6 space-y-4">
            <Skeleton className="h-5 w-40" />
            <div className="grid gap-4 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, idx) => (
                <Skeleton key={idx} className="h-10 w-full" />
              ))}
            </div>
            <Skeleton className="h-24 w-full" />
          </div>
        </div>

        {/* Right: Snapshot card */}
        <aside className="space-y-3 rounded-lg border bg-card p-4">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <div className="space-y-2 pt-3">
            {Array.from({ length: 4 }).map((_, idx) => (
              <Skeleton key={idx} className="h-4 w-full" />
            ))}
          </div>
        </aside>
      </div>
    </div>
  );
}
