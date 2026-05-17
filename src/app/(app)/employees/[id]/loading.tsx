/**
 * `loading.tsx` for `/employees/[id]` — skeleton shown while Prisma
 * fetches the user + stats (SPEC §13.4).
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function EmployeeDetailLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Header card */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-6">
          <Skeleton className="h-16 w-16 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72" />
            <Skeleton className="h-4 w-40" />
          </div>
        </div>
      </div>

      {/* Tabs */}
      <Skeleton className="h-10 w-48" />

      {/* Body */}
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <Skeleton className="h-5 w-40" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, idx) => (
            <Skeleton key={idx} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
