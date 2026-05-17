'use client';

/**
 * `error.tsx` for `/employees` — graceful fallback when the server
 * page throws (Prisma down, network blip, etc.). Per Next.js App
 * Router conventions, this is a Client Component and receives a
 * `reset` function that re-renders the route segment.
 */

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface EmployeesErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function EmployeesError({ error, reset }: EmployeesErrorProps) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[employees] route error', error);
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
          Couldn&apos;t load employees
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          Something went wrong while fetching the team list. Try again,
          or refresh the page.
        </p>
      </div>
      <Button type="button" onClick={reset} variant="outline" size="sm">
        Try again
      </Button>
    </div>
  );
}
