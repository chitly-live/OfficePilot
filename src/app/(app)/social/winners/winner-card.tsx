'use client';

/**
 * WinnerCard — single card on the `/social/winners` grid.
 *
 * SPEC.md §8.2.4 — winners are top-performing posts the team wants to
 * remember and repeat. The card surfaces the platform, caption
 * preview, engagement metrics, the published timestamp, and an
 * "unmark winner" affordance for editors.
 *
 * The mark/unmark control PATCHes `/api/social/posts/[id]` directly
 * with `{ isWinner: false }` and refreshes the route — that way the
 * grid stays in sync with the server without a page reload. The API
 * gates on "ADMIN or owner"; we mirror the affordance via `canEdit`.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  ExternalLink,
  Heart,
  Loader2,
  MessageCircle,
  Share2,
  Star,
  StarOff,
} from 'lucide-react';
import type { PostStatus, SocialPlatform } from '@prisma/client';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';
import type { SocialPostPublic } from '@/lib/schemas/social';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

/** Format a Date as `dd MMM yyyy`. */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return 'unscheduled';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

/** Trim a caption down to a multi-line preview suitable for cards. */
function captionPreview(caption: string, maxLen = 220): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen
    ? `${collapsed.slice(0, maxLen)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WinnerCardProps {
  post: SocialPostPublic;
  /**
   * When true, render the unmark-winner action. The server page
   * computes this against the session role + post ownership so the
   * card stays presentational.
   */
  canEdit: boolean;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function WinnerCard({ post, canEdit }: WinnerCardProps) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [optimisticOff, setOptimisticOff] = React.useState(false);

  const totalEngagement = post.likes + post.comments + post.shares;

  const handleUnmark = async () => {
    setOptimisticOff(true);
    try {
      const res = await fetch(`/api/social/posts/${post.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ isWinner: false }),
      });
      if (!res.ok) {
        setOptimisticOff(false);
        if (res.status === 403) {
          toast.error('You are not allowed to unmark this post.');
          return;
        }
        toast.error('Failed to unmark winner.');
        return;
      }
      toast.success('Removed from winners.');
      // Refresh the route so the grid drops this card on the next
      // render. We use a transition so the spinner shown during the
      // refresh doesn't block other interactions.
      startTransition(() => router.refresh());
    } catch {
      setOptimisticOff(false);
      toast.error('Network error. Please try again.');
    }
  };

  return (
    <Card
      className={cn(
        'flex h-full flex-col transition-opacity',
        optimisticOff && 'opacity-50',
      )}
    >
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Star
              className="h-3.5 w-3.5 fill-status-amber text-status-amber"
              aria-hidden="true"
            />
            {PLATFORM_LABELS[post.platform]}
          </span>
          <StatusBadge<PostStatus> status={post.status} />
        </div>
        <p className="text-xs text-muted-foreground">
          {post.publishedAt
            ? `Published ${formatDate(post.publishedAt)}`
            : `Scheduled ${formatDate(post.scheduledAt)}`}
        </p>
      </CardHeader>

      <CardContent className="flex-1 space-y-3 pt-0">
        <Link
          href={`/social/${post.id}`}
          className="block text-sm text-foreground hover:underline"
        >
          {captionPreview(post.caption)}
        </Link>

        {post.hashtags.length > 0 ? (
          <p className="text-xs text-muted-foreground">
            {post.hashtags
              .slice(0, 6)
              .map((t) => `#${t}`)
              .join(' ')}
            {post.hashtags.length > 6
              ? ` +${post.hashtags.length - 6} more`
              : ''}
          </p>
        ) : null}

        <dl className="grid grid-cols-3 gap-2 rounded-md border bg-muted/20 p-2 text-xs">
          <div className="flex flex-col items-start gap-0.5">
            <dt className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Heart className="h-3 w-3" aria-hidden="true" />
              Likes
            </dt>
            <dd className="font-medium tabular-nums text-foreground">
              {post.likes.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex flex-col items-start gap-0.5">
            <dt className="inline-flex items-center gap-0.5 text-muted-foreground">
              <MessageCircle className="h-3 w-3" aria-hidden="true" />
              Comments
            </dt>
            <dd className="font-medium tabular-nums text-foreground">
              {post.comments.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex flex-col items-start gap-0.5">
            <dt className="inline-flex items-center gap-0.5 text-muted-foreground">
              <Share2 className="h-3 w-3" aria-hidden="true" />
              Shares
            </dt>
            <dd className="font-medium tabular-nums text-foreground">
              {post.shares.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex flex-col items-start gap-0.5">
            <dt className="text-muted-foreground">Engagement</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {totalEngagement.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex flex-col items-start gap-0.5">
            <dt className="text-muted-foreground">Reach</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {post.reach.toLocaleString('en-IN')}
            </dd>
          </div>
          <div className="flex flex-col items-start gap-0.5">
            <dt className="text-muted-foreground">Impr.</dt>
            <dd className="font-medium tabular-nums text-foreground">
              {post.impressions.toLocaleString('en-IN')}
            </dd>
          </div>
        </dl>
      </CardContent>

      <CardFooter className="flex items-center justify-between gap-2 border-t pt-3">
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/social/${post.id}`}>View</Link>
          </Button>
          {post.externalUrl ? (
            <Button asChild variant="ghost" size="sm">
              <a href={post.externalUrl} target="_blank" rel="noreferrer">
                <ExternalLink className="h-4 w-4" aria-hidden="true" />
                <span>Open</span>
              </a>
            </Button>
          ) : null}
        </div>

        {canEdit ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleUnmark}
            disabled={pending || optimisticOff}
          >
            {pending || optimisticOff ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Removing…</span>
              </>
            ) : (
              <>
                <StarOff className="h-4 w-4" aria-hidden="true" />
                <span>Unmark</span>
              </>
            )}
          </Button>
        ) : null}
      </CardFooter>
    </Card>
  );
}
