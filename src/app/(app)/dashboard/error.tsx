'use client';

/**
 * `error.tsx` for `/dashboard` — graceful fallback when any of the
 * four dashboard loaders (`loadTodaysPulse`, `loadLatestInsights`,
 * `loadTimeline`, `loadFollowUps`) throws.
 *
 * Per Next.js App Router conventions, this is a Client Component and
 * receives a `reset` function that re-renders the route segment.
 * SPEC §13.5 — never show raw stack traces to end users; show a
 * friendly fallback instead and log the underlying error to the
 * server console for debugging.
 */

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface DashboardErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({
  error,
  reset,
}: DashboardErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[dashboard] route error', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive"
      >
        <AlertTriangle className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Couldn&apos;t load the dashboard
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Something went wrong while fetching today&apos;s pulse. Try
          again, or refresh the page.
        </p>
      </div>
      <Button type="button" onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
