/**
 * `/leads/[id]` — full lead detail (SPEC §6.1).
 *
 * Server Component. Authorisation:
 *   • Authenticated read for both ADMIN and EMPLOYEE — leads are a
 *     shared pipeline (SPEC §2.1).
 *   • Edit / convert authorisation is enforced by the API; we just
 *     surface the actions to the user.
 *   • Delete is admin-only (SPEC §6.3); the button is hidden for
 *     EMPLOYEE sessions.
 *
 * Layout:
 *   • PageHeader with name, status badge, and actions (Convert,
 *     Delete).
 *   • Two-column body (large screens) / stacked (mobile):
 *       Left column → Tabs:
 *         · Details: full inline edit form (PATCH /api/leads/[id])
 *         · Notes:   note feed + add-note form
 *         · Activity: activity log timeline
 *       Right column (always visible) → quick-glance card with
 *         identifiers, source, value, follow-up, tags.
 *
 * Data:
 *   • Lead + active-user list + notes feed + activity log are fetched
 *     in parallel via Prisma (no HTTP round-trip from a Server
 *     Component).
 *   • The activity log query is bounded to the 25 most recent rows for
 *     the timeline so the page stays snappy on long-lived leads.
 */

import * as React from 'react';
import { notFound, redirect } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft, CalendarClock, Mail, MapPin, Phone, Tag } from 'lucide-react';
import { format } from 'date-fns';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  leadPublicProjection,
  type LeadPublic,
} from '@/lib/schemas/leads';

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
import { StatusBadge } from '@/components/shared/StatusBadge';

import { LeadEditForm } from './lead-edit-form';
import { LeadConvertButton } from './lead-convert-button';
import { LeadDeleteButton } from './lead-delete-button';
import { LeadNotes, type LeadNote } from './lead-notes';
import { LeadActivity, type LeadActivityRow } from './lead-activity';
import type { OwnerOption } from '../new/lead-create-form';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVITY_LIMIT = 25;
const NOTES_LIMIT = 100;

/**
 * Format a Date as `dd MMM yyyy`. Returns `—` when the input is
 * falsy / un-parseable so the UI never shows "Invalid Date".
 */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

/** Format a Date as `dd MMM yyyy · HH:mm` (or `—`). */
function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy · HH:mm');
}

/** Format an INR value with the Indian numbering convention. */
function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

const SOURCE_LABELS: Record<string, string> = {
  WEBSITE: 'Website',
  WHATSAPP: 'WhatsApp',
  FACEBOOK_AD: 'Facebook Ad',
  GOOGLE_AD: 'Google Ad',
  INSTAGRAM: 'Instagram',
  REFERRAL: 'Referral',
  MANUAL: 'Manual',
  OTHER: 'Other',
};

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const lead = await prisma.lead.findUnique({
    where: { id: params.id },
    select: { name: true },
  });
  if (!lead) return { title: 'Lead' };
  return { title: lead.name };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function LeadDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/leads/${params.id}`);
  }

  const isAdmin = session.role === 'ADMIN';

  // Fetch lead, owner list, notes, and recent activity in parallel.
  const [lead, ownerRows, noteRows, activityRows] = await Promise.all([
    prisma.lead.findUnique({
      where: { id: params.id },
      select: leadPublicProjection,
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
    prisma.note.findMany({
      where: { entityType: 'lead', entityId: params.id },
      select: {
        id: true,
        body: true,
        createdAt: true,
        author: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: NOTES_LIMIT,
    }),
    prisma.activityLog.findMany({
      where: { leadId: params.id },
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
  ]);

  if (!lead) notFound();

  const leadPublic = lead as LeadPublic;

  // Authorisation hint for the inline edit form: the API enforces
  // "ADMIN or owner/creator can write", but we mirror it client-side
  // so disabled inputs render correctly when the current user can't
  // edit. EMPLOYEE-self also can't reassign to other users, only
  // ADMIN can.
  const canEdit =
    isAdmin ||
    leadPublic.ownerId === session.userId ||
    leadPublic.createdById === session.userId;

  // Map owners to dropdown options.
  const ownerOptions: OwnerOption[] = ownerRows.map((u) => ({
    id: u.id,
    label: u.name?.trim() || u.email,
  }));

  // Owner-id → display label lookup so the activity timeline can show
  // "assigned to Jane" instead of a bare cuid. Build it once and pass
  // down rather than threading every relation through.
  const ownerLabelById: Record<string, string> = {};
  for (const o of ownerRows) {
    ownerLabelById[o.id] = o.name?.trim() || o.email;
  }
  // The current owner might not be in the active-user list (deactivated
  // or out of the top 200) — make sure they show up.
  if (leadPublic.owner && !ownerLabelById[leadPublic.owner.id]) {
    ownerLabelById[leadPublic.owner.id] =
      leadPublic.owner.name?.trim() || leadPublic.owner.email;
  }

  const notes: LeadNote[] = noteRows.map((n) => ({
    id: n.id,
    body: n.body,
    createdAt: n.createdAt.toISOString(),
    author: {
      id: n.author.id,
      name: n.author.name,
      email: n.author.email,
      avatarUrl: n.author.avatarUrl,
    },
  }));

  const activity: LeadActivityRow[] = activityRows.map((a) => ({
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

  // ISO → YYYY-MM-DD + HH:MM for the date/time inputs in the edit form.
  const followUp = leadPublic.nextFollowUpAt
    ? new Date(leadPublic.nextFollowUpAt)
    : null;
  const followUpDate = followUp ? format(followUp, 'yyyy-MM-dd') : '';
  const followUpTime = followUp ? format(followUp, 'HH:mm') : '';

  const isConverted = leadPublic.status === 'CONVERTED';

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{leadPublic.name}</span>
            <StatusBadge status={leadPublic.status} />
          </span>
        }
        subtitle={
          leadPublic.company
            ? `${leadPublic.company}${leadPublic.city ? ` · ${leadPublic.city}` : ''}`
            : undefined
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/leads">
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                <span>Back</span>
              </Link>
            </Button>
            {canEdit && !isConverted ? (
              <LeadConvertButton
                leadId={leadPublic.id}
                leadName={leadPublic.name}
              />
            ) : null}
            {isAdmin ? (
              <LeadDeleteButton
                leadId={leadPublic.id}
                leadName={leadPublic.name}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: Tabs */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="details" className="space-y-4">
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="notes">
                Notes
                {notes.length > 0 ? (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {notes.length}
                  </span>
                ) : null}
              </TabsTrigger>
              <TabsTrigger value="activity">Activity</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Edit lead</CardTitle>
                  <CardDescription>
                    {canEdit
                      ? isAdmin
                        ? 'Admins can update any field, including reassigning owners.'
                        : 'Update profile, status, and follow-up. Reassigning to another user is admin-only.'
                      : 'You don\u2019t own this lead. Read-only view.'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <LeadEditForm
                    leadId={leadPublic.id}
                    isAdmin={isAdmin}
                    canEdit={canEdit}
                    currentUserId={session.userId}
                    ownerOptions={ownerOptions}
                    initialValues={{
                      name: leadPublic.name,
                      phone: leadPublic.phone,
                      email: leadPublic.email,
                      company: leadPublic.company,
                      city: leadPublic.city,
                      source: leadPublic.source,
                      status: leadPublic.status,
                      priority: leadPublic.priority,
                      value: leadPublic.value,
                      tags: leadPublic.tags,
                      ownerId: leadPublic.ownerId,
                      followUpDate,
                      followUpTime,
                      notes: leadPublic.notes,
                    }}
                  />
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="notes" className="space-y-4">
              <LeadNotes leadId={leadPublic.id} notes={notes} />
            </TabsContent>

            <TabsContent value="activity" className="space-y-4">
              <LeadActivity
                items={activity}
                ownerLabelById={ownerLabelById}
              />
            </TabsContent>
          </Tabs>
        </div>

        {/* Right: quick-glance card */}
        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Snapshot</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {leadPublic.email ? (
                <SnapshotRow icon={Mail} label="Email" value={leadPublic.email} />
              ) : null}
              {leadPublic.phone ? (
                <SnapshotRow icon={Phone} label="Phone" value={leadPublic.phone} />
              ) : null}
              {leadPublic.city ? (
                <SnapshotRow
                  icon={MapPin}
                  label="City"
                  value={leadPublic.city}
                />
              ) : null}

              <div className="grid gap-2 border-t pt-3">
                <SnapshotKV
                  label="Source"
                  value={SOURCE_LABELS[leadPublic.source] ?? leadPublic.source}
                />
                <SnapshotKV
                  label="Priority"
                  value={
                    <StatusBadge status={leadPublic.priority} />
                  }
                />
                <SnapshotKV
                  label="Value"
                  value={
                    <span className="font-medium tabular-nums">
                      {formatInr(leadPublic.value)}
                    </span>
                  }
                />
                <SnapshotKV
                  label="Owner"
                  value={
                    leadPublic.owner ? (
                      <span>{leadPublic.owner.name || leadPublic.owner.email}</span>
                    ) : (
                      <span className="text-muted-foreground">Unassigned</span>
                    )
                  }
                />
                <SnapshotKV
                  label="Created"
                  value={formatDate(leadPublic.createdAt)}
                />
                {leadPublic.convertedAt ? (
                  <SnapshotKV
                    label="Converted"
                    value={formatDate(leadPublic.convertedAt)}
                  />
                ) : null}
              </div>

              {leadPublic.nextFollowUpAt ? (
                <div className="flex items-start gap-2 rounded-md border bg-muted/40 p-2 text-xs">
                  <CalendarClock
                    className="mt-0.5 h-4 w-4 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div>
                    <div className="font-medium text-foreground">
                      Next follow-up
                    </div>
                    <div className="text-muted-foreground">
                      {formatDateTime(leadPublic.nextFollowUpAt)}
                    </div>
                  </div>
                </div>
              ) : null}

              {leadPublic.tags.length > 0 ? (
                <div className="space-y-1.5 border-t pt-3">
                  <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Tag className="h-3.5 w-3.5" aria-hidden="true" />
                    Tags
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {leadPublic.tags.map((t) => (
                      <span
                        key={t}
                        className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-foreground"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Snapshot row helpers — local, presentational
// ---------------------------------------------------------------------------

function SnapshotRow({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="truncate text-sm text-foreground">{value}</div>
      </div>
    </div>
  );
}

function SnapshotKV({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="text-right text-sm">{value}</span>
    </div>
  );
}
