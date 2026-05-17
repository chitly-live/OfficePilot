/**
 * `/social/[id]` — full social post detail (SPEC.md §8.1, §8.2.2,
 * §8.2.3, §8.2.4).
 *
 * Server Component. Authorisation:
 *   • Authenticated read for both ADMIN and EMPLOYEE — social is a
 *     shared workspace (SPEC.md §2.1).
 *   • Edit authorisation is enforced by the API; we surface
 *     read-only inputs when the current user can't write.
 *
 * Layout:
 *   • PageHeader with caption preview, status badge, winner star, and
 *     a "Back" action.
 *   • Engagement metrics card (likes / comments / shares / reach /
 *     impressions). Manually entered, per SPEC.md §8.2.3.
 *   • Tabs:
 *       · Overview — editable form covering every PATCH-able field.
 *       · Activity — ActivityLog where `entityType='socialpost' AND
 *         entityId=id`.
 *
 * Data is fetched in parallel via Prisma — no HTTP round-trip from
 * a Server Component.
 */

import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  ArrowLeft,
  CalendarRange,
  ExternalLink,
  Hash,
  Heart,
  MessageCircle,
  Share2,
  Star,
} from 'lucide-react';
import { format } from 'date-fns';
import type { PostStatus } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  socialPostPublicProjection,
  type SocialPostPublic,
} from '@/lib/schemas/social';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import {
  SocialPostActivity,
  type SocialPostActivityRow,
} from './post-activity';
import { SocialPostEditForm } from './social-post-edit-form';
import { parseHashtagSets } from '../hashtag-sets';
import type { OwnerOption } from '../new/social-post-create-form';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVITY_LIMIT = 25;

const PLATFORM_LABELS: Record<string, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

/** Format a Date as `dd MMM yyyy · HH:mm`. */
function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy · HH:mm');
}

/** Trim a caption down to a single short preview line for the header. */
function captionPreview(caption: string, maxLen = 80): string {
  const collapsed = caption.replace(/\s+/g, ' ').trim();
  return collapsed.length > maxLen
    ? `${collapsed.slice(0, maxLen)}…`
    : collapsed;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const post = await prisma.socialPost.findUnique({
    where: { id: params.id },
    select: { caption: true },
  });
  if (!post) return { title: 'Post' };
  return { title: captionPreview(post.caption, 60) };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function SocialPostDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/social/${params.id}`);
  }

  const isAdmin = session.role === 'ADMIN';

  // Fetch post + owner list + activity + hashtag library in parallel.
  const [post, ownerRows, activityRows, hashtagSetting] = await Promise.all([
    prisma.socialPost.findUnique({
      where: { id: params.id },
      select: socialPostPublicProjection,
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
    prisma.activityLog.findMany({
      where: { entityType: 'socialpost', entityId: params.id },
      select: {
        id: true,
        action: true,
        entityType: true,
        entityId: true,
        leadId: true,
        metadata: true,
        createdAt: true,
        userId: true,
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ACTIVITY_LIMIT,
    }),
    // Read the hashtag library so the composer can render quick-paste
    // buttons above the hashtag input (SPEC.md §8.2 #5, §12.1 #5).
    prisma.setting.findUnique({ where: { key: 'hashtag_sets' } }),
  ]);

  if (!post) notFound();

  const postPublic = post as SocialPostPublic;

  // The API enforces "ADMIN or owner" for any PATCH; mirror that
  // here so disabled inputs render correctly when the current user
  // can't edit.
  const canEdit = isAdmin || postPublic.ownerId === session.userId;

  // Owner options for the edit-form select. Always include the
  // current owner — even if they're outside the active-user list (top
  // 200 / deactivated) — so the dropdown reflects the real value.
  const ownerOptionsMap = new Map<string, OwnerOption>();
  for (const u of ownerRows) {
    ownerOptionsMap.set(u.id, { id: u.id, label: u.name?.trim() || u.email });
  }
  if (postPublic.owner && !ownerOptionsMap.has(postPublic.owner.id)) {
    ownerOptionsMap.set(postPublic.owner.id, {
      id: postPublic.owner.id,
      label: postPublic.owner.name?.trim() || postPublic.owner.email,
    });
  }
  const ownerOptions: OwnerOption[] = Array.from(ownerOptionsMap.values());

  const hashtagSets = parseHashtagSets(hashtagSetting?.value);

  const activity: SocialPostActivityRow[] = activityRows.map((a) => ({
    id: a.id,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    leadId: a.leadId,
    metadata: (a.metadata ?? null) as Record<string, unknown> | null,
    createdAt: a.createdAt.toISOString(),
    userId: a.userId,
    user: {
      id: a.user.id,
      name: a.user.name,
      email: a.user.email,
      avatarUrl: a.user.avatarUrl,
    },
  }));

  // Engagement total — used by the headline metric card.
  const totalEngagement =
    postPublic.likes + postPublic.comments + postPublic.shares;

  // Compute when the post is/was scheduled or live for the header.
  const platformLabel =
    PLATFORM_LABELS[postPublic.platform] ?? postPublic.platform;
  const whenLabel = postPublic.publishedAt
    ? `Published ${formatDateTime(postPublic.publishedAt)}`
    : postPublic.scheduledAt
      ? `Scheduled ${formatDateTime(postPublic.scheduledAt)}`
      : 'Unscheduled';

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="truncate">{captionPreview(postPublic.caption, 60)}</span>
            <StatusBadge<PostStatus> status={postPublic.status} />
            {postPublic.isWinner ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-status-amber/10 px-2 py-0.5 text-xs font-medium text-status-amber ring-1 ring-inset ring-status-amber/20">
                <Star className="h-3 w-3 fill-current" aria-hidden="true" />
                Winner
              </span>
            ) : null}
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span>{platformLabel}</span>
            <span className="inline-flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
              {whenLabel}
            </span>
            {postPublic.externalUrl ? (
              <a
                href={postPublic.externalUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                Open on platform
              </a>
            ) : null}
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/social">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back</span>
            </Link>
          </Button>
        }
      />

      {/* Engagement metrics card row. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <StatCard
          label="Engagement"
          value={totalEngagement.toLocaleString('en-IN')}
          delta={{
            direction: totalEngagement > 0 ? 'up' : 'flat',
            label: 'likes + comments + shares',
          }}
        />
        <StatCard
          label="Likes"
          value={postPublic.likes.toLocaleString('en-IN')}
        />
        <StatCard
          label="Comments"
          value={postPublic.comments.toLocaleString('en-IN')}
        />
        <StatCard
          label="Reach"
          value={postPublic.reach.toLocaleString('en-IN')}
        />
        <StatCard
          label="Impressions"
          value={postPublic.impressions.toLocaleString('en-IN')}
        />
      </div>

      {/* Caption + media + hashtag preview card. */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Preview</CardTitle>
          <CardDescription>
            Caption, hashtags, and media as they would appear on the
            platform. v1 doesn&apos;t auto-publish — copy the caption to
            the platform after publishing.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="whitespace-pre-wrap text-sm text-foreground">
            {postPublic.caption}
          </p>

          {postPublic.hashtags.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {postPublic.hashtags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                >
                  <Hash
                    className="h-3 w-3 text-muted-foreground"
                    aria-hidden="true"
                  />
                  {tag}
                </span>
              ))}
            </div>
          ) : null}

          {postPublic.mediaUrls.length > 0 ? (
            <ul className="space-y-1.5">
              {postPublic.mediaUrls.map((url) => (
                <li key={url}>
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-foreground hover:underline"
                    title={url}
                  >
                    <ExternalLink
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="truncate">{url}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {/* Inline engagement summary so a reader doesn't have to
              scroll to the StatCard row above. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t pt-3 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Heart className="h-3.5 w-3.5" aria-hidden="true" />
              {postPublic.likes.toLocaleString('en-IN')}
            </span>
            <span className="inline-flex items-center gap-1">
              <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
              {postPublic.comments.toLocaleString('en-IN')}
            </span>
            <span className="inline-flex items-center gap-1">
              <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
              {postPublic.shares.toLocaleString('en-IN')}
            </span>
            <span className={cn('inline-flex items-center gap-1')}>
              Reach{' '}
              <span className="font-medium text-foreground">
                {postPublic.reach.toLocaleString('en-IN')}
              </span>
            </span>
            <span className="inline-flex items-center gap-1">
              Impressions{' '}
              <span className="font-medium text-foreground">
                {postPublic.impressions.toLocaleString('en-IN')}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Edit post</CardTitle>
              <CardDescription>
                {canEdit
                  ? isAdmin
                    ? 'Admins can update any field, including reassigning owners.'
                    : 'Update fields and metrics. Reassigning to another user is admin-only.'
                  : 'You don\u2019t own this post. Read-only view.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SocialPostEditForm
                postId={postPublic.id}
                isAdmin={isAdmin}
                canEdit={canEdit}
                currentUserId={session.userId}
                ownerOptions={ownerOptions}
                hashtagSets={hashtagSets}
                initialValues={{
                  platform: postPublic.platform,
                  status: postPublic.status,
                  caption: postPublic.caption,
                  mediaUrls: postPublic.mediaUrls,
                  hashtags: postPublic.hashtags,
                  scheduledAt: postPublic.scheduledAt,
                  publishedAt: postPublic.publishedAt,
                  externalId: postPublic.externalId,
                  externalUrl: postPublic.externalUrl,
                  likes: postPublic.likes,
                  comments: postPublic.comments,
                  shares: postPublic.shares,
                  reach: postPublic.reach,
                  impressions: postPublic.impressions,
                  isWinner: postPublic.isWinner,
                  ownerId: postPublic.ownerId,
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <SocialPostActivity items={activity} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
