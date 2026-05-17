/**
 * `loading.tsx` for `/dashboard` — skeleton shown while the page's
 * `Promise.all` of loaders is in flight (SPEC §13.4).
 *
 * Mirrors the four-row layout of the real page so the user doesn't
 * see a layout shift when content lands:
 *
 *   Row 1 — 4 KPI cards (`<TodaysPulse>`)
 *   Row 2 — 4 insight cards (`<LatestInsights>`)
 *   Row 3 — Full-width timeline placeholder (`<ReleaseCampaignTimeline>`)
 *   Row 4 — 2-up Quick actions + Reminders (`<QuickActionsReminders>`)
 *
 * The same Tailwind responsive grids are used, so the skeleton also
 * collapses correctly on mobile per SPEC §11.2.
 */

import { Skeleton } from '@/components/ui/skeleton';

const ROW_1_CARDS = 4;
const ROW_2_CARDS = 4;

export default function DashboardLoading() {
  return (
    <div className="space-y-6">
      {/* PageHeader skeleton */}
      <div className="flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-7 w-56" />
          <Skeleton className="h-4 w-44" />
        </div>
      </div>

      {/* Row 1 — Today's pulse */}
      <section
        aria-hidden="true"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {Array.from({ length: ROW_1_CARDS }).map((_, i) => (
          <div
            key={`pulse-${i}`}
            className="space-y-3 rounded-md border bg-card p-4"
          >
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-7 w-16" />
            <Skeleton className="h-3 w-28" />
          </div>
        ))}
      </section>

      {/* Row 2 — Latest AI insights */}
      <section
        aria-hidden="true"
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
      >
        {Array.from({ length: ROW_2_CARDS }).map((_, i) => (
          <div
            key={`insight-${i}`}
            className="space-y-3 rounded-md border bg-card p-4"
          >
            <div className="flex items-center justify-between">
              <Skeleton className="h-5 w-16" />
              <Skeleton className="h-5 w-5 rounded-full" />
            </div>
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <div className="flex items-center justify-between pt-2">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
        ))}
      </section>

      {/* Row 3 — Release + Campaign timeline */}
      <div className="space-y-3 rounded-md border bg-card p-4">
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-48 w-full" />
      </div>

      {/* Row 4 — Quick actions + Reminders */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-3 rounded-md border bg-card p-4">
          <Skeleton className="h-5 w-32" />
          <div className="grid grid-cols-2 gap-3">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        </div>
        <div className="space-y-4 rounded-md border bg-card p-4">
          <Skeleton className="h-5 w-44" />
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-4/6" />
          </div>
          <div className="space-y-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
          </div>
        </div>
      </div>
    </div>
  );
}
