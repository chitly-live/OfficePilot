/**
 * `loading.tsx` for `/settings` — skeleton shown while Prisma loads
 * the settings snapshot (SPEC §13.4).
 *
 * Mirrors the eventual layout (header + tabbed settings form) so
 * there's no layout shift when the real content lands.
 */

import { Skeleton } from '@/components/ui/skeleton';

const TAB_FIELD_COUNT = 6;

export default function SettingsLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>

      {/* Tab list */}
      <Skeleton className="h-10 w-full max-w-md" />

      {/* Active tab body */}
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-72" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: TAB_FIELD_COUNT }).map((_, idx) => (
            <div key={idx} className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
        <div className="flex justify-end">
          <Skeleton className="h-9 w-32" />
        </div>
      </div>
    </div>
  );
}
