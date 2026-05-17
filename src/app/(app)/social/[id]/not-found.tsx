/**
 * `not-found.tsx` for `/social/[id]` — rendered when `notFound()` is
 * called (post id doesn't exist). Replaces the default Next.js 404
 * so the styling stays consistent with the rest of the app.
 */

import Link from 'next/link';
import { Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';

export default function SocialPostNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed bg-muted/20 px-6 py-16 text-center">
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Sparkles className="h-6 w-6" />
      </span>
      <div className="space-y-1">
        <h2 className="text-base font-semibold text-foreground">
          Post not found
        </h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          The post you&apos;re looking for doesn&apos;t exist or has been
          deleted.
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link href="/social">Back to posts</Link>
      </Button>
    </div>
  );
}
