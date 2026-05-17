/**
 * `/dashboard` — unified dashboard (SPEC.md §11.1, §11.2).
 *
 * Server Component. Composes the four widget rows added in Wave 8
 * (tasks 75–78) over the loaders in `./loaders.ts` (task 74):
 *
 *   Row 1 — Today's pulse              `<TodaysPulse>`
 *   Row 2 — Latest AI insights         `<LatestInsights>`
 *   Row 3 — Release + Campaign         `<ReleaseCampaignTimeline>`
 *           Timeline (last 30 days)
 *   Row 4 — Quick actions + Reminders  `<QuickActionsReminders>`
 *
 * Auth & RBAC:
 *
 *   - The route group `(app)` already redirects anonymous visitors to
 *     `/login` from `src/app/(app)/layout.tsx`, but we also enforce it
 *     here so a deep link cached by the browser can't slip past a
 *     stale cookie. Redirects preserve `callbackUrl=/dashboard`.
 *   - The dashboard itself is visible to every authenticated employee
 *     (SPEC §2.1). Only the AI Insights "View →" / "Generate one"
 *     affordances are admin-gated, so we forward `isAdmin` into
 *     `<LatestInsights>`.
 *
 * Data fetching:
 *
 *   - All four loaders run under one outer `Promise.all` so the page's
 *     time-to-first-byte is bounded by the slowest single loader, not
 *     the sum. Each loader is dependency-injected with the shared
 *     Prisma singleton from `@/lib/db`.
 *   - `dynamic = 'force-dynamic'` because the data is per-request live
 *     (today's leads, today's spend, today's posts, etc.) and must
 *     not be cached.
 *
 * Mobile (SPEC §11.2):
 *
 *   The four widget components own their own responsive grids
 *   (`grid-cols-1 sm:grid-cols-2 lg:grid-cols-4` for rows 1+2,
 *   `overflow-x-auto` for the timeline, `grid-cols-1 lg:grid-cols-2`
 *   for row 4). The page just stacks them with `space-y-6`, so a
 *   375px viewport collapses every row vertically without horizontal
 *   overflow.
 */

import { redirect } from 'next/navigation';
import { format } from 'date-fns';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { PageHeader } from '@/components/shared/PageHeader';

import { LatestInsights } from './latest-insights';
import {
  loadFollowUps,
  loadLatestInsights,
  loadTimeline,
  loadTodaysPulse,
} from './loaders';
import { QuickActionsReminders } from './quick-actions-reminders';
import { ReleaseCampaignTimeline } from './release-campaign-timeline';
import { TodaysPulse } from './todays-pulse';

export const metadata = {
  title: 'Dashboard',
};

// Per-request live data — must never be cached across users or days.
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  // ------------------------------------------------------------------
  // 1. Auth gate.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/dashboard');
  }

  // ------------------------------------------------------------------
  // 2. Parallel data fetch — one Promise.all so TTFB == slowest loader.
  // ------------------------------------------------------------------
  const [pulse, insights, timeline, followUps] = await Promise.all([
    loadTodaysPulse(prisma),
    loadLatestInsights(prisma),
    loadTimeline(prisma),
    loadFollowUps(prisma),
  ]);

  const isAdmin = session.role === 'ADMIN';

  // Greeting: "Welcome back, <name>" when we have one, else just
  // "Dashboard" — keeps the header dense on accounts with no name.
  const userName = session.user?.name?.trim();
  const headerTitle =
    userName && userName.length > 0 ? `Welcome back, ${userName}` : 'Dashboard';
  const headerSubtitle = format(new Date(), 'EEEE, MMMM d');

  // ------------------------------------------------------------------
  // 3. Render — vertical stack of the four widget rows.
  // ------------------------------------------------------------------
  return (
    <div className="space-y-6">
      <PageHeader title={headerTitle} subtitle={headerSubtitle} />

      <TodaysPulse data={pulse} />

      <LatestInsights data={insights} isAdmin={isAdmin} />

      <ReleaseCampaignTimeline data={timeline} />

      <QuickActionsReminders followUps={followUps} />
    </div>
  );
}
