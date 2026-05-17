/**
 * `/employees/[id]` — employee profile, stats, and attendance (SPEC §5.1, §5.2).
 *
 * Server Component. Authorisation:
 *   • ADMIN          → can view anyone's profile.
 *   • EMPLOYEE       → can only view their own profile (self-only).
 *   • Anyone else    → redirected to `/dashboard`.
 *
 * Mirrors the API split (`GET /api/users/[id]`, `GET
 * /api/users/[id]/stats`) with direct Prisma reads — same pattern as
 * `/employees/page.tsx`. We deliberately avoid HTTP round-trips from
 * server components per Next.js App Router guidance.
 *
 * Stats shape mirrors `GET /api/users/[id]/stats` (see
 * `src/app/api/users/[id]/stats/route.ts`) so a future swap to a
 * client-side fetch would be a drop-in replacement.
 *
 * The page composes:
 *   • Header card — avatar + name + role + designation + active state.
 *   • Two-tab layout (Profile / Stats) using shadcn Tabs.
 *       Profile: `EmployeeProfileForm` (client) — re-uses
 *                `userUpdateSchema` shape; admin sees all fields,
 *                self sees the safe subset.
 *       Stats:   `<StatCard>` grid + attendance pill + attendance
 *                marker form (client).
 *   • Admin-only "Deactivate" button on the header (uses
 *     `ConfirmDialog`); hidden when the admin is viewing their own
 *     profile (self-deactivation guard, SPEC §2.1).
 */

import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { LeadStatus, DevTaskStatus } from '@prisma/client';
import { format } from 'date-fns';
import { subDays, startOfDay } from 'date-fns';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  ATTENDANCE_STATUSES,
  userPublicProjection,
  type AttendanceStatus,
  type UserPublic,
} from '@/lib/schemas/users';

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
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { PageHeader } from '@/components/shared/PageHeader';
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';

import { EmployeeProfileForm } from './employee-profile-form';
import { AttendanceForm } from './attendance-form';
import { DeactivateButton } from './deactivate-button';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ATTENDANCE_WINDOW_DAYS = 30;

type AttendanceCounts = Record<AttendanceStatus, number>;

interface UserStats {
  leadsOwned: number;
  leadsConverted: number;
  campaignsOwned: number;
  socialPostsOwned: number;
  devTasksAssigned: number;
  devTasksCompleted: number;
  attendanceLast30Days: AttendanceCounts;
  conversionRate: number;
}

/** Fetch the user's performance snapshot. Mirrors the API exactly so
 *  this server-side read returns the same shape as a future client
 *  fetch would. */
async function fetchUserStats(userId: string): Promise<UserStats> {
  const windowStart = startOfDay(subDays(new Date(), ATTENDANCE_WINDOW_DAYS));

  const [
    leadsOwned,
    leadsConverted,
    campaignsOwned,
    socialPostsOwned,
    devTasksAssigned,
    devTasksCompleted,
    attendanceGroups,
  ] = await Promise.all([
    prisma.lead.count({ where: { ownerId: userId } }),
    prisma.lead.count({
      where: { ownerId: userId, status: LeadStatus.CONVERTED },
    }),
    prisma.campaign.count({ where: { ownerId: userId } }),
    prisma.socialPost.count({ where: { ownerId: userId } }),
    prisma.devTask.count({ where: { assigneeId: userId } }),
    prisma.devTask.count({
      where: { assigneeId: userId, status: DevTaskStatus.DONE },
    }),
    prisma.attendance.groupBy({
      by: ['status'],
      where: { userId, date: { gte: windowStart } },
      _count: { _all: true },
    }),
  ]);

  const attendanceLast30Days: AttendanceCounts = {
    present: 0,
    leave: 0,
    wfh: 0,
    absent: 0,
  };
  for (const row of attendanceGroups) {
    if ((ATTENDANCE_STATUSES as readonly string[]).includes(row.status)) {
      attendanceLast30Days[row.status as AttendanceStatus] = row._count._all;
    }
  }

  const conversionRate = leadsOwned > 0 ? leadsConverted / leadsOwned : 0;

  return {
    leadsOwned,
    leadsConverted,
    campaignsOwned,
    socialPostsOwned,
    devTasksAssigned,
    devTasksCompleted,
    attendanceLast30Days,
    conversionRate,
  };
}

function getInitials(name: string | null | undefined, email: string): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  return (email.trim()[0] ?? '?').toUpperCase();
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

/** Pretty-print 0.42 as "42%". */
function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '0%';
  return `${Math.round(fraction * 100)}%`;
}

// ---------------------------------------------------------------------------
// Metadata (per-page title)
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: { name: true, email: true },
  });
  if (!user) return { title: 'Employee' };
  return { title: user.name || user.email || 'Employee' };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function EmployeeDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/employees/${params.id}`);
  }

  const isSelf = session.userId === params.id;
  const isAdmin = session.role === 'ADMIN';

  // Authorisation: admin can view anyone, employees only themselves.
  if (!isAdmin && !isSelf) {
    redirect('/dashboard');
  }

  const user = await prisma.user.findUnique({
    where: { id: params.id },
    select: userPublicProjection,
  });
  if (!user) notFound();

  const employee = user as UserPublic;
  const stats = await fetchUserStats(employee.id);

  const attendanceTotal = Object.values(stats.attendanceLast30Days).reduce(
    (sum, count) => sum + count,
    0,
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title={employee.name || employee.email}
        subtitle={employee.designation || 'Employee profile'}
        actions={
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/employees">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back</span>
              </Link>
            </Button>
            {/* Self-deactivation is forbidden server-side; hide the
                button entirely when an admin is viewing their own
                profile so the UI doesn't tease an action that can't
                succeed. */}
            {isAdmin && !isSelf && employee.isActive ? (
              <DeactivateButton
                userId={employee.id}
                userName={employee.name || employee.email}
              />
            ) : null}
          </div>
        }
      />

      {/* Header card — avatar + identity + status. */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:gap-6">
          <Avatar className="h-16 w-16">
            {employee.avatarUrl ? (
              <AvatarImage
                src={employee.avatarUrl}
                alt={employee.name ?? employee.email}
              />
            ) : null}
            <AvatarFallback className="bg-brand-100 text-base font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
              {getInitials(employee.name, employee.email)}
            </AvatarFallback>
          </Avatar>

          <div className="flex flex-1 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold text-foreground">
                {employee.name || '—'}
              </span>
              <StatusBadge
                status={employee.role}
                tone={employee.role === 'ADMIN' ? 'blue' : 'neutral'}
                label={employee.role === 'ADMIN' ? 'Admin' : 'Employee'}
              />
              {employee.isActive ? (
                <StatusBadge status="ACTIVE" tone="green" label="Active" />
              ) : (
                <StatusBadge status="INACTIVE" tone="red" label="Inactive" />
              )}
            </div>
            <div className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
              <span>{employee.email}</span>
              {employee.phone ? <span>{employee.phone}</span> : null}
              {employee.designation ? (
                <span>{employee.designation}</span>
              ) : null}
              <span>Joined {formatDate(employee.joinedAt)}</span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Profile / Stats tabs. */}
      <Tabs defaultValue="profile" className="space-y-4">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Edit profile</CardTitle>
              <CardDescription>
                {isAdmin
                  ? 'Admins can update any field. Use the deactivate button above to disable login.'
                  : 'Update your name, contact, and avatar. Email and role changes are admin-only.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EmployeeProfileForm
                userId={employee.id}
                isAdmin={isAdmin}
                initialValues={{
                  email: employee.email,
                  name: employee.name,
                  role: employee.role,
                  phone: employee.phone,
                  designation: employee.designation,
                  // ISO → YYYY-MM-DD for the native date input.
                  joinedAt: format(
                    new Date(employee.joinedAt),
                    'yyyy-MM-dd',
                  ),
                  avatarUrl: employee.avatarUrl,
                  moduleAccess: employee.moduleAccess,
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stats" className="space-y-4">
          <section
            aria-label="Performance snapshot"
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"
          >
            <StatCard
              label="Leads owned"
              value={stats.leadsOwned.toLocaleString('en-IN')}
            />
            <StatCard
              label="Leads converted"
              value={stats.leadsConverted.toLocaleString('en-IN')}
            />
            <StatCard
              label="Conversion rate"
              value={formatPercent(stats.conversionRate)}
            />
            <StatCard
              label="Campaigns owned"
              value={stats.campaignsOwned.toLocaleString('en-IN')}
            />
            <StatCard
              label="Social posts"
              value={stats.socialPostsOwned.toLocaleString('en-IN')}
            />
            <StatCard
              label="Dev tasks assigned"
              value={stats.devTasksAssigned.toLocaleString('en-IN')}
            />
            <StatCard
              label="Dev tasks completed"
              value={stats.devTasksCompleted.toLocaleString('en-IN')}
            />
            <StatCard
              label="Attendance (30d)"
              value={`${attendanceTotal} marks`}
            />
          </section>

          {/* Attendance breakdown pill. */}
          <Card>
            <CardHeader>
              <CardTitle>Attendance — last 30 days</CardTitle>
              <CardDescription>
                Counts from {formatDate(startOfDay(subDays(new Date(), 30)))}{' '}
                onwards.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {ATTENDANCE_STATUSES.map((status) => {
                  const count = stats.attendanceLast30Days[status];
                  const tone =
                    status === 'present'
                      ? 'green'
                      : status === 'wfh'
                        ? 'blue'
                        : status === 'leave'
                          ? 'amber'
                          : 'red';
                  return (
                    <StatusBadge
                      key={status}
                      status={status.toUpperCase()}
                      tone={tone}
                      label={`${status.toUpperCase()} · ${count}`}
                    />
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Attendance marker. Self can mark own; admin can mark
              anyone — the API enforces this. */}
          <Card>
            <CardHeader>
              <CardTitle>Mark attendance</CardTitle>
              <CardDescription>
                {isSelf
                  ? "Set today's attendance. You can re-mark to overwrite."
                  : 'Override attendance for this employee on any date.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AttendanceForm userId={employee.id} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
