/**
 * `/marketing/[id]` — full campaign detail (SPEC §7.1, §7.2.2,
 * §7.2.3, §7.2.4).
 *
 * Server Component. Authorisation:
 *   • Authenticated read for both ADMIN and EMPLOYEE — campaigns are
 *     a shared workspace (SPEC §2.1).
 *   • Edit authorisation is enforced by the API; we surface
 *     read-only inputs when the current user can't write.
 *
 * Layout:
 *   • PageHeader with name, status badge, and "Back" action.
 *   • KPI row: spent vs budget (with progress bar), CAC = spent /
 *     conversions, CPL = spent / signups, ROI when applicable.
 *   • Tabs:
 *       · Overview — editable form + KPI snapshot.
 *       · Linked leads — leads auto-linked via `utm_campaign`
 *         (SPEC §7.2.3).
 *       · Activity — ActivityLog where `entityType='campaign' AND
 *         entityId=id`.
 *
 * Data is fetched in parallel via Prisma — no HTTP round-trip from
 * a Server Component.
 */

import * as React from 'react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, CalendarRange, Megaphone } from 'lucide-react';
import { format } from 'date-fns';
import type { CampaignStatus } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  campaignPublicProjection,
  type CampaignPublic,
} from '@/lib/schemas/campaigns';
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
import { StatCard } from '@/components/shared/StatCard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import { cn } from '@/lib/utils';

import { CampaignActivity, type CampaignActivityRow } from './campaign-activity';
import { CampaignEditForm } from './campaign-edit-form';
import { CampaignLeadsList } from './campaign-leads-list';
import type { OwnerOption } from '../new/campaign-create-form';

export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ACTIVITY_LIMIT = 25;
const LINKED_LEADS_LIMIT = 50;

/** Format a Date as `dd MMM yyyy`. */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

/** Format an INR value. Returns `—` for null/undefined/non-finite. */
function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: params.id },
    select: { name: true },
  });
  if (!campaign) return { title: 'Campaign' };
  return { title: campaign.name };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default async function CampaignDetailPage({ params }: PageProps) {
  const session = await auth();
  if (!session?.userId) {
    redirect(`/login?callbackUrl=/marketing/${params.id}`);
  }

  const isAdmin = session.role === 'ADMIN';

  // 1. Fetch campaign + owner list + activity in parallel. Linked
  //    leads need the campaign's `utmCampaign` first, so they're
  //    fetched in step 2 once we know whether a tag exists.
  const [campaign, ownerRows, activityRows] = await Promise.all([
    prisma.campaign.findUnique({
      where: { id: params.id },
      select: campaignPublicProjection,
    }),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    }),
    prisma.activityLog.findMany({
      where: { entityType: 'campaign', entityId: params.id },
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

  if (!campaign) notFound();

  const campaignPublic = campaign as CampaignPublic;
  const hasUtmTag = !!campaignPublic.utmCampaign;

  // 2. Linked leads — only when the campaign has a UTM tag. Mirrors
  //    `/api/campaigns/[id]/leads`: when no tag is set, no leads can
  //    ever be auto-linked, so we skip the query entirely.
  const [linkedLeadRows, linkedLeadCount] = hasUtmTag
    ? await Promise.all([
        prisma.lead.findMany({
          where: { utmCampaign: campaignPublic.utmCampaign! },
          select: leadPublicProjection,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take: LINKED_LEADS_LIMIT,
        }),
        prisma.lead.count({
          where: { utmCampaign: campaignPublic.utmCampaign! },
        }),
      ])
    : [[] as Array<unknown>, 0];

  const linkedLeads = linkedLeadRows as LeadPublic[];

  // The API enforces "ADMIN or owner" for any PATCH; mirror that
  // here so disabled inputs render correctly when the current user
  // can't edit.
  const canEdit = isAdmin || campaignPublic.ownerId === session.userId;

  // Owner options for the edit-form select. Always include the
  // current owner — even if they're outside the active-user list (top
  // 200 / deactivated) — so the dropdown reflects the real value.
  const ownerOptionsMap = new Map<string, OwnerOption>();
  for (const u of ownerRows) {
    ownerOptionsMap.set(u.id, { id: u.id, label: u.name?.trim() || u.email });
  }
  if (campaignPublic.owner && !ownerOptionsMap.has(campaignPublic.owner.id)) {
    ownerOptionsMap.set(campaignPublic.owner.id, {
      id: campaignPublic.owner.id,
      label:
        campaignPublic.owner.name?.trim() || campaignPublic.owner.email,
    });
  }
  const ownerOptions: OwnerOption[] = Array.from(ownerOptionsMap.values());

  const activity: CampaignActivityRow[] = activityRows.map((a) => ({
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

  // 3. KPI calculations.
  const cac =
    campaignPublic.conversions > 0
      ? campaignPublic.spent / campaignPublic.conversions
      : null;
  const cpl =
    campaignPublic.signups > 0
      ? campaignPublic.spent / campaignPublic.signups
      : null;
  // ROI is "(value - cost) / cost". We only show ROI when the
  // campaign has both spend and budget recorded; using budget as
  // the "expected return" is meaningless, so we treat `value =
  // signups` (lead count) only when conversions are real money.
  // Until we have real revenue tracking on `Campaign`, omit ROI
  // unless conversions × budget gives a sensible signal — which
  // they don't. We surface a simple "spent vs budget" % instead.
  const spentPct =
    campaignPublic.budget > 0
      ? (campaignPublic.spent / campaignPublic.budget) * 100
      : 0;
  const overBudget = spentPct > 100;
  const clampedSpentPct = Math.min(100, Math.max(0, spentPct));

  const dateRangeLabel =
    formatDate(campaignPublic.startDate) +
    (campaignPublic.endDate
      ? ` → ${formatDate(campaignPublic.endDate)}`
      : ' → ongoing');

  return (
    <div className="space-y-6">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{campaignPublic.name}</span>
            <StatusBadge<CampaignStatus> status={campaignPublic.status} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="inline-flex items-center gap-1">
              <Megaphone className="h-3.5 w-3.5" aria-hidden="true" />
              {campaignPublic.channel.replace(/_/g, ' ').toLowerCase()}
            </span>
            <span className="inline-flex items-center gap-1">
              <CalendarRange className="h-3.5 w-3.5" aria-hidden="true" />
              {dateRangeLabel}
            </span>
            {campaignPublic.utmCampaign ? (
              <span className="font-mono text-muted-foreground">
                utm: {campaignPublic.utmCampaign}
              </span>
            ) : null}
          </span>
        }
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/marketing">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span>Back</span>
            </Link>
          </Button>
        }
      />

      {/* KPI cards. */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Budget"
          value={formatInr(campaignPublic.budget)}
        />
        <StatCard
          label="Spent"
          value={formatInr(campaignPublic.spent)}
          delta={{
            direction: overBudget
              ? 'up'
              : spentPct >= 80
                ? 'flat'
                : 'down',
            label: `${spentPct.toFixed(0)}% of budget`,
          }}
          // Higher spend % → worse for the spend card semantics.
          invertColor
        />
        <StatCard
          label="CAC (₹/conversion)"
          value={cac === null ? '—' : formatInr(cac)}
          // Lower CAC is better.
          invertColor
        />
        <StatCard
          label="CPL (₹/signup)"
          value={cpl === null ? '—' : formatInr(cpl)}
          // Lower CPL is better.
          invertColor
        />
      </div>

      {/* Spent-vs-budget progress bar — visual aid for the spent
          card. Caps the visual width at 100 % but shows the raw % for
          over-budget runs. */}
      <Card>
        <CardContent className="space-y-2 p-4">
          <div className="flex items-baseline justify-between text-sm">
            <span className="font-medium text-foreground">Spend progress</span>
            <span
              className={cn(
                'tabular-nums',
                overBudget ? 'text-status-red' : 'text-muted-foreground',
              )}
            >
              {formatInr(campaignPublic.spent)} of{' '}
              {formatInr(campaignPublic.budget)} ·{' '}
              <span className="font-medium">{spentPct.toFixed(1)}%</span>
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                overBudget
                  ? 'bg-status-red'
                  : spentPct >= 80
                    ? 'bg-status-amber'
                    : 'bg-status-green',
              )}
              style={{ width: `${clampedSpentPct}%` }}
            />
          </div>
          <div className="grid gap-2 pt-2 sm:grid-cols-4 sm:gap-4 text-xs">
            <KvRow label="Impressions" value={campaignPublic.impressions} />
            <KvRow label="Clicks" value={campaignPublic.clicks} />
            <KvRow label="Signups" value={campaignPublic.signups} />
            <KvRow label="Conversions" value={campaignPublic.conversions} />
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="leads">
            Linked leads
            {linkedLeadCount > 0 ? (
              <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {linkedLeadCount}
              </span>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Edit campaign</CardTitle>
              <CardDescription>
                {canEdit
                  ? isAdmin
                    ? 'Admins can update any field, including reassigning owners.'
                    : 'Update fields and metrics. Reassigning to another user is admin-only.'
                  : 'You don\u2019t own this campaign. Read-only view.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CampaignEditForm
                campaignId={campaignPublic.id}
                isAdmin={isAdmin}
                canEdit={canEdit}
                currentUserId={session.userId}
                ownerOptions={ownerOptions}
                initialValues={{
                  name: campaignPublic.name,
                  channel: campaignPublic.channel,
                  status: campaignPublic.status,
                  startDate: campaignPublic.startDate,
                  endDate: campaignPublic.endDate,
                  budget: campaignPublic.budget,
                  spent: campaignPublic.spent,
                  impressions: campaignPublic.impressions,
                  clicks: campaignPublic.clicks,
                  signups: campaignPublic.signups,
                  conversions: campaignPublic.conversions,
                  utmSource: campaignPublic.utmSource,
                  utmMedium: campaignPublic.utmMedium,
                  utmCampaign: campaignPublic.utmCampaign,
                  notes: campaignPublic.notes,
                  ownerId: campaignPublic.ownerId,
                }}
              />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="leads" className="space-y-4">
          <CampaignLeadsList
            items={linkedLeads}
            total={linkedLeadCount}
            hasUtmTag={hasUtmTag}
          />
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <CampaignActivity items={activity} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

function KvRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 sm:flex-col sm:items-start">
      <span className="uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="font-medium tabular-nums text-foreground">
        {value.toLocaleString('en-IN')}
      </span>
    </div>
  );
}
