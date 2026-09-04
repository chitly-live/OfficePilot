/**
 * `not-found.tsx` for `/finance/*` — consistent 404 for deleted or
 * mistyped transaction / party ids.
 */

import Link from 'next/link';
import { FileQuestion } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function FinanceNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <FileQuestion className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">Not found</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          That finance record doesn&apos;t exist or was deleted.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/finance">Back to finance</Link>
      </Button>
    </div>
  );
}
