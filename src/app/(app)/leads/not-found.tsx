/**
 * `not-found.tsx` for `/leads` — replaces the default Next.js 404 so
 * the styling stays consistent with the rest of the app. Used when
 * `notFound()` is called from a child page or a deep link arrives
 * with a non-existent segment that hasn't matched anything else.
 */

import Link from 'next/link';
import { UserX } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function LeadsNotFound() {
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
          Page not found
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or has moved.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/leads">Back to leads</Link>
      </Button>
    </div>
  );
}
