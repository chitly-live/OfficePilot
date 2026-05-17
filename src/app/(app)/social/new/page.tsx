/**
 * `/social/new` — compose post form (SPEC.md §8.1, §8.2.2).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate: redirect to `/login` if no session. Both ADMIN and
 *      EMPLOYEE may create posts (SPEC.md §2.1, §8).
 *   2. Load the active-user list server-side so the owner select on
 *      the form is populated without a client-side roundtrip.
 *      EMPLOYEEs can only assign new posts to themselves; the API
 *      enforces it regardless, but rendering only the self-option
 *      makes the constraint visible.
 *   3. Render the `SocialPostCreateForm` client component that drives
 *      `react-hook-form` + zod against `socialPostCreateSchema` and
 *      posts to `POST /api/social/posts`.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';

import { parseHashtagSets } from '../hashtag-sets';
import {
  SocialPostCreateForm,
  type OwnerOption,
} from './social-post-create-form';

export const metadata = {
  title: 'New post',
};

export const dynamic = 'force-dynamic';

export default async function NewSocialPostPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/social/new');
  }

  // Build the owner list. Admins see every active user; employees
  // only see themselves — they can't assign new posts to anyone else
  // (SPEC.md §2.1 + the social posts POST RBAC).
  const [ownerRows, hashtagSetting] = await Promise.all([
    session.role === 'ADMIN'
      ? prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
          take: 200,
        })
      : prisma.user.findMany({
          where: { id: session.userId, isActive: true },
          select: { id: true, name: true, email: true },
          take: 1,
        }),
    // Read the hashtag library so the composer can render quick-paste
    // buttons above the hashtag input (SPEC.md §8.2 #5, §12.1 #5).
    prisma.setting.findUnique({ where: { key: 'hashtag_sets' } }),
  ]);

  const ownerOptions: OwnerOption[] = ownerRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  const hashtagSets = parseHashtagSets(hashtagSetting?.value);

  return (
    <div className="space-y-6">
      <PageHeader
        title="New post"
        subtitle="Compose a draft or schedule one for later. Publishing happens manually after the post goes live."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/social">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to social</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Post details</CardTitle>
          <CardDescription>
            v1 doesn&apos;t auto-publish to any platform. Update the
            status to <strong>Published</strong> after the post is live
            and paste the public URL on the detail page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SocialPostCreateForm
            currentUserId={session.userId}
            currentUserRole={session.role}
            ownerOptions={ownerOptions}
            hashtagSets={hashtagSets}
          />
        </CardContent>
      </Card>
    </div>
  );
}
