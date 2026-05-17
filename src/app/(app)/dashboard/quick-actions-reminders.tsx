/**
 * Dashboard Row 4 — Quick actions + Reminders (SPEC.md §11.1).
 *
 * Two-column grid that closes out the dashboard:
 *
 *   • Left  — "Quick actions" card. Four `Button`s linking to the
 *             dedicated full-form create pages (`/leads/new`,
 *             `/dev/new`, `/social/new`, `/marketing/new`). The
 *             cross-page Quick Add modal lives in the topbar (see
 *             `src/components/layout/quick-add-modal.tsx`); these
 *             buttons are alternative jump-offs so the dashboard is
 *             actionable on its own.
 *
 *   • Right — "Follow-up reminders" card with two stacked sections:
 *             "Overdue" (red badge, leads whose `nextFollowUpAt` is
 *             before today) and "Today" (blue badge, leads due today).
 *             Each section shows up to 5 rows; when a bucket has
 *             more, a "View all (N more)" link drops the user onto
 *             `/leads` to keep the page itself dense.
 *
 * Server Component — no client interactivity beyond `<Link>` navigation.
 * The data shape (`FollowUpBuckets`) is produced by `loadFollowUps` in
 * `./loaders.ts` (task 74).
 */

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';
import { Megaphone, Plus, Send, UserPlus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

import type { FollowUpBuckets, FollowUpLead } from './loaders';

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface QuickActionsRemindersProps {
  /** Output of `loadFollowUps()` (see `./loaders.ts`). */
  followUps: FollowUpBuckets;
}

/**
 * Cap on follow-up rows rendered per bucket. Anything beyond this is
 * surfaced via the "View all (N more)" affordance — the dashboard is a
 * glance surface, not the leads list.
 */
const ROW_LIMIT = 5;

/** Quick-action buttons (left card). Order matches SPEC.md §11.1 row 4. */
const QUICK_ACTIONS: ReadonlyArray<{
  href: string;
  label: string;
  Icon: React.ComponentType<{ 'aria-hidden'?: boolean | 'true' | 'false' }>;
}> = [
  { href: '/leads/new', label: 'New Lead', Icon: UserPlus },
  { href: '/dev/new', label: 'New Task', Icon: Plus },
  { href: '/social/new', label: 'New Post', Icon: Send },
  { href: '/marketing/new', label: 'New Campaign', Icon: Megaphone },
];

export function QuickActionsReminders({
  followUps,
}: QuickActionsRemindersProps) {
  const { todaysFollowUps, overdueFollowUps } = followUps;

  const overdueShown = overdueFollowUps.slice(0, ROW_LIMIT);
  const overdueRest = Math.max(overdueFollowUps.length - ROW_LIMIT, 0);
  const todayShown = todaysFollowUps.slice(0, ROW_LIMIT);
  const todayRest = Math.max(todaysFollowUps.length - ROW_LIMIT, 0);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* --- Left: Quick actions -------------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Quick actions</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3">
            {QUICK_ACTIONS.map(({ href, label, Icon }) => (
              <Button key={href} asChild variant="outline" size="lg">
                <Link href={href}>
                  <Icon aria-hidden="true" />
                  <span>{label}</span>
                </Link>
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* --- Right: Follow-up reminders ------------------------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Follow-up reminders</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <FollowUpSection
            heading="Overdue"
            headingId="dashboard-overdue-followups"
            badgeVariant="destructive"
            totalCount={overdueFollowUps.length}
            shown={overdueShown}
            restCount={overdueRest}
            emptyLabel="No overdue follow-ups"
          />

          <FollowUpSection
            heading="Today"
            headingId="dashboard-today-followups"
            badgeVariant="blue"
            totalCount={todaysFollowUps.length}
            shown={todayShown}
            restCount={todayRest}
            emptyLabel="No follow-ups today"
          />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components (server-only)
// ---------------------------------------------------------------------------

interface FollowUpSectionProps {
  heading: string;
  headingId: string;
  /** `'destructive'` = red (overdue); `'blue'` = info-blue (today). */
  badgeVariant: 'destructive' | 'blue';
  totalCount: number;
  shown: readonly FollowUpLead[];
  restCount: number;
  emptyLabel: string;
}

function FollowUpSection({
  heading,
  headingId,
  badgeVariant,
  totalCount,
  shown,
  restCount,
  emptyLabel,
}: FollowUpSectionProps) {
  return (
    <section aria-labelledby={headingId}>
      <div className="mb-2 flex items-center gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          {heading}
        </h3>
        {badgeVariant === 'destructive' ? (
          <Badge variant="destructive">{totalCount}</Badge>
        ) : (
          // shadcn `Badge` doesn't ship a blue variant — match the
          // dashboard convention (red = overdue, blue = today) with
          // explicit utility classes.
          <Badge className="border-transparent bg-blue-600 text-white hover:bg-blue-600/80">
            {totalCount}
          </Badge>
        )}
      </div>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((lead) => (
            <FollowUpRow key={lead.id} lead={lead} />
          ))}
        </ul>
      )}

      {restCount > 0 && (
        <Link
          href="/leads"
          className="mt-2 inline-block text-xs font-medium text-primary hover:underline"
        >
          View all ({restCount} more)
        </Link>
      )}
    </section>
  );
}

function FollowUpRow({ lead }: { lead: FollowUpLead }) {
  return (
    <li className="flex items-start justify-between gap-3 text-sm">
      <div className="min-w-0 flex-1">
        <div className="truncate">
          <Link
            href={`/leads/${lead.id}`}
            className="font-medium hover:underline"
          >
            {lead.name}
          </Link>
          {lead.company !== null && lead.company.trim() !== '' && (
            <span className="ml-1 text-xs text-muted-foreground">
              · {lead.company}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Owner: {lead.ownerName ?? 'Unassigned'}
        </p>
      </div>
      <time
        dateTime={lead.nextFollowUpAt.toISOString()}
        className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
      >
        {formatDistanceToNow(lead.nextFollowUpAt, { addSuffix: true })}
      </time>
    </li>
  );
}
