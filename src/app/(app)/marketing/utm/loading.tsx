/**
 * `loading.tsx` for `/marketing/utm` — skeleton shown while the
 * server page renders / auth gate resolves (SPEC §13.4).
 *
 * The UTM builder is a pure client form (no Prisma reads), so this
 * skeleton just mirrors the header + form card so there's no layout
 * shift when the page hydrates.
 */

import { Skeleton } from '@/components/ui/skeleton';

const FIELD_COUNT = 6;

export default function MarketingUtmLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-9 w-36" />
      </div>

      {/* Builder card skeleton */}
      <div className="max-w-3xl space-y-4 rounded-lg border bg-card p-6">
        <Skeleton className="h-5 w-44" />
        <Skeleton className="h-4 w-64" />
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: FIELD_COUNT }).map((_, idx) => (
            <div key={idx} className="space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-10 w-full" />
            </div>
          ))}
        </div>
        <Skeleton className="h-20 w-full rounded-md" />
      </div>
    </div>
  );
}
