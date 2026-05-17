/**
 * `/leads/new` — add lead form (SPEC §6.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate: redirect to `/login` if no session. Both ADMIN and
 *      EMPLOYEE may create leads (SPEC §6.4 — owner defaults to the
 *      creator, admin can reassign).
 *   2. Load the active-user list server-side so the owner select on
 *      the form is populated without a client-side roundtrip.
 *      EMPLOYEEs can only assign new leads to themselves (SPEC §6.4),
 *      so we filter the list down to the current user when the
 *      session role is EMPLOYEE — the API enforces the same rule
 *      server-side.
 *   3. Render a card with the `LeadCreateForm` client component that
 *      drives `react-hook-form` + zod validation against
 *      `leadCreateSchema`, posts to `POST /api/leads`, and redirects
 *      to `/leads/[id]` on success.
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

import { LeadCreateForm, type OwnerOption } from './lead-create-form';

export const metadata = {
  title: 'New lead',
};

export const dynamic = 'force-dynamic';

export default async function NewLeadPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/leads/new');
  }

  // Build the owner list. Admins see every active user; employees
  // only see themselves (SPEC §6.4 — employees can't assign new
  // leads to anyone else, and showing a single self-only option
  // tells them clearly what's allowed).
  const ownerRows = session.role === 'ADMIN'
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
        title="New lead"
        subtitle="Capture a customer inquiry — set source, priority, and a follow-up."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/leads">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to leads</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Lead details</CardTitle>
          <CardDescription>
            Either a phone or an email is required. The lead is owned by
            you unless an admin assigns someone else.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LeadCreateForm
            currentUserId={session.userId}
            currentUserRole={session.role}
            ownerOptions={ownerOptions}
          />
        </CardContent>
      </Card>
    </div>
  );
}
