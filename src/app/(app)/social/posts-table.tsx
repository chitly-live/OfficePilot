'use client';

/**
 * SocialPostsTable — DataTable wrapper for the /social list view
 * (SPEC.md §8.1, §8.2.1).
 *
 * Columns:
 *   • caption preview (link to detail) + hashtag count
 *   • platform
 *   • status badge
 *   • scheduledAt / publishedAt (whichever applies)
 *   • engagement — likes + comments + shares
 *   • reach
 *   • owner (avatar + name)
 *   • actions (link to detail)
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. Receives the already-fetched + serialised list from
 * the server page.
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Heart, ImagePlus, MessageCircle, Plus, Share2, Star } from 'lucide-react';
import type { PostStatus, SocialPlatform } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { SocialPostPublic } from '@/lib/schemas/social';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-letter avatar fallback. */
function getInitials(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromFallback = fallback.trim()[0];
  return (fromFallback ?? '?').toUpperCase();
}

/** Friendly display label for `SocialPlatform`. */
const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

/** Format a Date as `dd MMM yyyy · HH:mm`. Returns `—` for null. */
function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy · HH:mm');
}

/** Trim a caption down to a single short preview line. */
function captionPreview(caption: string, maxLen = 80): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen
    ? `${collapsed.slice(0, maxLen)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface SocialPostsTableProps {
  items: SocialPostPublic[];
}

export function SocialPostsTable({ items }: SocialPostsTableProps) {
  const columns = React.useMemo<DataTableColumn<SocialPostPublic>[]>(
    () => [
      {
        id: 'caption',
        header: 'Post',
        cell: ({ row }) => {
          const p = row.original;
          return (
            <div className="min-w-0">
              <Link
                href={`/social/${p.id}`}
                className="block truncate text-sm font-medium text-foreground hover:underline"
              >
                {captionPreview(p.caption)}
              </Link>
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                {p.hashtags.length > 0 ? (
                  <span>
                    {p.hashtags.length} tag
                    {p.hashtags.length === 1 ? '' : 's'}
                  </span>
                ) : null}
                {p.mediaUrls.length > 0 ? (
                  <span>
                    {p.mediaUrls.length} media
                  </span>
                ) : null}
                {p.isWinner ? (
                  <span className="inline-flex items-center gap-1 text-status-amber">
                    <Star
                      className="h-3 w-3 fill-current"
                      aria-hidden="true"
                    />
                    winner
                  </span>
                ) : null}
              </div>
            </div>
          );
        },
      },
      {
        id: 'platform',
        header: 'Platform',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {PLATFORM_LABELS[row.original.platform]}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <StatusBadge<PostStatus> status={row.original.status} />
        ),
      },
      {
        id: 'when',
        header: 'When',
        cell: ({ row }) => {
          const p = row.original;
          // Published posts show the publish time (the meaningful
          // moment); everything else shows the scheduled time.
          const value = p.publishedAt ?? p.scheduledAt;
          return (
            <span className="text-sm text-muted-foreground">
              {formatDateTime(value)}
            </span>
          );
        },
      },
      {
        id: 'engagement',
        header: () => <span className="block text-right">Engagement</span>,
        cell: ({ row }) => {
          const p = row.original;
          const total = p.likes + p.comments + p.shares;
          return (
            <div className="flex flex-col items-end gap-0.5 text-right text-sm tabular-nums">
              <span className="font-medium text-foreground">
                {total.toLocaleString('en-IN')}
              </span>
              <span className="flex items-center gap-2 text-xs text-muted-foreground">
                <span
                  className="inline-flex items-center gap-0.5"
                  title={`${p.likes} likes`}
                >
                  <Heart className="h-3 w-3" aria-hidden="true" />
                  {p.likes.toLocaleString('en-IN')}
                </span>
                <span
                  className="inline-flex items-center gap-0.5"
                  title={`${p.comments} comments`}
                >
                  <MessageCircle
                    className="h-3 w-3"
                    aria-hidden="true"
                  />
                  {p.comments.toLocaleString('en-IN')}
                </span>
                <span
                  className="inline-flex items-center gap-0.5"
                  title={`${p.shares} shares`}
                >
                  <Share2 className="h-3 w-3" aria-hidden="true" />
                  {p.shares.toLocaleString('en-IN')}
                </span>
              </span>
            </div>
          );
        },
      },
      {
        id: 'reach',
        header: () => <span className="block text-right">Reach</span>,
        cell: ({ row }) => (
          <span className="block text-right font-medium tabular-nums text-foreground">
            {row.original.reach.toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        id: 'owner',
        header: 'Owner',
        cell: ({ row }) => {
          const owner = row.original.owner;
          return (
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                {owner.avatarUrl ? (
                  <AvatarImage src={owner.avatarUrl} alt={owner.name} />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(owner.name, owner.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-sm text-foreground">
                {owner.name || owner.email}
              </span>
            </div>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/social/${row.original.id}`}>View</Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<SocialPostPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: ImagePlus,
        title: 'No posts found',
        description:
          'Adjust the filters above, or create your first post to start filling the calendar.',
        action: (
          <Button asChild size="sm">
            <Link href="/social/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>New post</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
