/**
 * `/social/winners` — gallery of posts marked as winners (SPEC.md
 * §8.1, §8.2.4).
 *
 * Server Component. Renders a card grid of every post where
 * `isWinner = true`. The set is small by design (winners are
 * hand-picked top performers), so this page isn't paginated — the
 * gallery view shows the entire collection.
 *
 * Authorisation:
 *   • Authenticated read for both ADMIN and EMPLOYEE — social is a
 *     shared workspace (SPEC.md §2.1). Anyone can browse the gallery
 *     for inspiration.
 *   • The "Unmark winner" affordance on each card is gated client-
 *     side based on session role + post ownership; the API enforces
 *     the same check on PATCH.
 *
 * Optional `?platform=INSTAGRAM,FACEBOOK` filter narrows the gallery
 * to one or more platforms — same convention as the API and the
 * `/social` list filters.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, Trophy } from 'lucide-react';
import { Prisma, SocialPlatform } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  socialPostPublicProjection,
  socialWinnersQuerySchema,
  type SocialPostPublic,
} from '@/lib/schemas/social';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { EmptyState } from '@/components/shared/EmptyState';

import { WinnerCard } from './winner-card';

export const metadata = {
  title: 'Winners',
};

// Always render fresh — the gallery reflects live DB state.
export const dynamic = 'force-dynamic';

/** Hard cap on the gallery — winners are hand-picked, but cap so a
 *  pathological dataset still renders in finite time. Mirrors the
 *  API route's ceiling. */
const MAX_WINNERS = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Coerce Next.js's `string | string[] | undefined` searchParam shape
 * into a single string. Multi-value filters are stored as comma-
 * joined strings in the URL.
 */
function coerceParam(
  raw: string | string[] | undefined,
): string | undefined {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) {
    const joined = raw.filter(Boolean).join(',');
    return joined.length > 0 ? joined : undefined;
  }
  return raw;
}

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

interface WinnersPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function SocialWinnersPage({
  searchParams,
}: WinnersPageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/social/winners');
  }

  const isAdmin = session.role === 'ADMIN';

  // Validate the search params with the same schema the API route
  // uses; fall back to defaults on invalid input.
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = coerceParam(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }
  const parsed = socialWinnersQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : socialWinnersQuerySchema.parse({});

  const where: Prisma.SocialPostWhereInput = { isWinner: true };
  if (query.platform && query.platform.length > 0) {
    where.platform = { in: query.platform };
  }

  // Most recently updated first — winners can age, so the freshest
  // entries land near the top of the gallery.
  const orderBy: Prisma.SocialPostOrderByWithRelationInput[] = [
    { updatedAt: 'desc' },
    { id: 'asc' },
  ];

  const items = (await prisma.socialPost.findMany({
    where,
    select: socialPostPublicProjection,
    orderBy,
    take: MAX_WINNERS,
  })) as unknown as SocialPostPublic[];

  // Build a pretty subtitle reflecting active filters.
  const filterSummary =
    query.platform && query.platform.length > 0
      ? query.platform.map((p) => PLATFORM_LABELS[p]).join(', ')
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>Winners</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-status-amber/10 px-2 py-0.5 text-xs font-medium text-status-amber ring-1 ring-inset ring-status-amber/20">
              <Trophy className="h-3 w-3" aria-hidden="true" />
              {items.length}
            </span>
          </span>
        }
        subtitle={
          filterSummary
            ? `Top-performing posts on ${filterSummary} — repeat what works.`
            : 'Top-performing posts across every channel — repeat what works.'
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/social">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to social</span>
            </Link>
          </Button>
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={Trophy}
          title="No winners yet"
          description='Mark a post as "winner" from its detail page to surface it here as inspiration for future content.'
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/social">Browse posts</Link>
            </Button>
          }
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((post) => {
            const canEdit = isAdmin || post.ownerId === session.userId;
            return (
              <WinnerCard
                key={post.id}
                post={post}
                canEdit={canEdit}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
