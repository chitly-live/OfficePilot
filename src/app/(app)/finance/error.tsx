'use client';

/**
 * `error.tsx` for `/finance/*` — graceful fallback when a server page
 * throws. Client Component per Next.js convention; `reset` re-renders
 * the route segment.
 */

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';

interface FinanceErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function FinanceError({ error, reset }: FinanceErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[finance] route error', error);
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
          Couldn&apos;t load finance data
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Something went wrong while reading the ledger. Try again, or refresh
          the page.
        </p>
      </div>
      <Button type="button" onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
