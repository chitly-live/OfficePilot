/**
 * `/dev/new` — add task form (SPEC.md §9.1, §9.2.5).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate: redirect to `/login` if no session. Both ADMIN and
 *      EMPLOYEE may create tasks (SPEC.md §9 — dev is a shared
 *      workspace; the API auto-assigns `reporterId = session.userId`).
 *   2. Load the active-user list server-side so the assignee select
 *      on the form is populated without a client-side roundtrip.
 *   3. Render a card with the `DevTaskCreateForm` client component
 *      that drives `react-hook-form` + zod validation against the
 *      same shape as `devTaskCreateSchema`, posts to `POST /api/dev/
 *      tasks`, and redirects to `/dev` on success.
 *
 * The form auto-defaults the assignee to the current user ("Assign
 * to me" — SPEC.md §9.2.5). Type-specific fields (RELEASE,
 * BUG-specific) are revealed conditionally based on the selected
 * type so a fast feature capture isn't cluttered with bug fields.
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
  DevTaskCreateForm,
  type AssigneeOption,
} from './dev-task-create-form';

export const metadata = {
  title: 'New task',
};

export const dynamic = 'force-dynamic';

export default async function NewDevTaskPage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dev/new');
  }

  // Load all active users for the assignee select. Dev is a shared
  // workspace — both ADMIN and EMPLOYEE can pick anyone.
  const assigneeRows = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true, name: true, email: true },
    orderBy: [{ name: 'asc' }, { email: 'asc' }],
    take: 200,
  });

  const assigneeOptions: AssigneeOption[] = assigneeRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="New task"
        subtitle="Capture a feature, bug, chore, or release log entry."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/dev">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to dev</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Task details</CardTitle>
          <CardDescription>
            Default assignee is you. Switch the type to log a bug
            (with affects-version + repro steps) or a release.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DevTaskCreateForm
            currentUserId={session.userId}
            assigneeOptions={assigneeOptions}
          />
        </CardContent>
      </Card>
    </div>
  );
}
