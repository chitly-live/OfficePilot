/**
 * `/employees/new` — admin-only "add employee" form (SPEC §5.1, §5.4).
 *
 * Server Component. Responsibilities:
 *
 *   1. Auth gate: redirect to `/login` for unauthenticated users and
 *      to `/dashboard` for non-admins. SPEC §5.4 explicitly forbids
 *      employees from reaching this page.
 *   2. Render a card with the `EmployeeCreateForm` client component
 *      that drives `react-hook-form` + zod validation against
 *      `userCreateSchema`, posts to `POST /api/users`, and redirects
 *      to `/employees/[id]` on success.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';

import { auth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PageHeader } from '@/components/shared/PageHeader';

import { EmployeeCreateForm } from './employee-create-form';

export const metadata = {
  title: 'New employee',
};

export const dynamic = 'force-dynamic';

export default async function NewEmployeePage() {
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/employees/new');
  }
  if (session.role !== 'ADMIN') {
    // Soft redirect — non-admins land on the dashboard rather than
    // a blunt 403, mirroring the middleware behaviour for
    // admin-only paths.
    redirect('/dashboard');
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="New employee"
        subtitle="Create an account so the new team member can log in."
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/employees">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back to employees</span>
            </Link>
          </Button>
        }
      />

      <Card className="max-w-3xl">
        <CardHeader>
          <CardTitle>Profile details</CardTitle>
          <CardDescription>
            Email and password are required. The new user can sign in
            immediately with the credentials you set.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <EmployeeCreateForm />
        </CardContent>
      </Card>
    </div>
  );
}
