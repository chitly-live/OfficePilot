/**
 * `/marketing/new` — create campaign form (SPEC §7.1, §7.2.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate: redirect to `/login` if no session. Both ADMIN and
 *      EMPLOYEE may create campaigns (SPEC §2.1, §7).
 *   2. Load the active-user list server-side so the owner select on
 *      the form is populated without a client-side roundtrip.
 *      EMPLOYEEs can only assign new campaigns to themselves
 *      (mirrors the leads behaviour); the API enforces it regardless,
 *      but rendering only the self-option makes the constraint
 *      visible.
 *   3. Render the `CampaignCreateForm` client component that drives
 *      `react-hook-form` + zod against `campaignCreateSchema` and
 *      posts to `POST /api/campaigns`.
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

import {
  CampaignCreateForm,
  type OwnerOption,
} from './campaign-create-form';

export const metadata = {
  title: 'New campaign',
};

export const dynamic = 'force-dynamic';

export default async function NewCampaignPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/marketing/new');
  }

  // Build the owner list. Admins see every active user; employees
  // only see themselves — they can't assign new campaigns to anyone
  // else (SPEC §2.1 + the campaigns POST RBAC).
  const ownerRows =
    session.role === 'ADMIN'
      ? await prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
          take: 200,
        })
      : await prisma.user.findMany({
          where: { id: session.userId, isActive: true },
          select: { id: true, name: true, email: true },
          take: 1,
        });

  const ownerOptions: OwnerOption[] = ownerRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New campaign"
        subtitle="Set the budget, dates, and UTM tags. You can update spend and metrics later."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/marketing">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to campaigns</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Campaign details</CardTitle>
          <CardDescription>
            UTM tags are optional but strongly recommended — leads with a
            matching <code>utm_campaign</code> auto-link to this campaign.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CampaignCreateForm
            currentUserId={session.userId}
            currentUserRole={session.role}
            ownerOptions={ownerOptions}
          />
        </CardContent>
      </Card>
    </div>
  );
}
