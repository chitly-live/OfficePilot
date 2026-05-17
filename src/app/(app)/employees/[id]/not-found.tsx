/**
 * `not-found.tsx` for `/employees/[id]` — rendered when `notFound()`
 * is called (employee id doesn't exist). Replaces the default Next.js
 * 404 page so the styling stays consistent with the rest of the app.
 */

import Link from 'next/link';
import { UserX } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function EmployeeNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <UserX className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Employee not found
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          The profile you&apos;re looking for doesn&apos;t exist or has been
          removed.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/employees">Back to employees</Link>
      </Button>
    </div>
  );
}
