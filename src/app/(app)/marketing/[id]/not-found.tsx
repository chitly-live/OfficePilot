/**
 * `not-found.tsx` for `/marketing/[id]` — rendered when `notFound()`
 * is called (campaign id doesn't exist). Replaces the default
 * Next.js 404 so the styling stays consistent with the rest of
 * the app.
 */

import Link from 'next/link';
import { Megaphone } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function CampaignNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Megaphone className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Campaign not found
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          The campaign you&apos;re looking for doesn&apos;t exist or has
          been deleted.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/marketing">Back to campaigns</Link>
      </Button>
    </div>
  );
}
