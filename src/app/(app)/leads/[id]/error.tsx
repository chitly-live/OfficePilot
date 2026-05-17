'use client';

/**
 * `error.tsx` for `/leads/[id]` — fallback for runtime errors. Distinct
 * from `not-found.tsx`, which handles a missing lead via `notFound()`.
 */

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface LeadDetailErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function LeadDetailError({
  error,
  reset,
}: LeadDetailErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[leads/[id]] route error', error);
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
          Couldn&apos;t load this lead
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Something went wrong fetching the lead record. Try again, or
          refresh the page.
        </p>
      </div>
      <Button type="button" onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
