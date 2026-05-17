/**
 * `loading.tsx` for `/leads/import` — skeleton shown while the
 * server page renders / auth gate resolves (SPEC §13.4).
 *
 * The CSV import form itself is a client island that does its own
 * staged loading (parse → preview → upload), so this skeleton just
 * mirrors the header + an upload-card placeholder so there's no
 * layout shift when the page finishes hydrating.
 */

import { Skeleton } from '@/components/ui/skeleton';

export default function LeadsImportLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-44" />
          <Skeleton className="h-4 w-80" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>

      {/* Upload card skeleton */}
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
        <Skeleton className="h-32 w-full rounded-md border-dashed" />
        <div className="flex justify-end">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </div>
  );
}
