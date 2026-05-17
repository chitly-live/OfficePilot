/**
 * `<TodaysPulse>` — Row 1 of the unified dashboard (SPEC §11.1 row 1
 * "Today's pulse — 4 cards"):
 *
 *   1. New leads today      — count + day-over-day delta
 *   2. Ad spend today (₹)   — INR amount + delta
 *   3. Posts published today — total + per-platform mini-icons
 *   4. Open dev tasks       — total + "in progress" subcount
 *
 * Server Component (no `'use client'`). Pure presentational — receives
 * pre-loaded data from {@link import('./loaders').loadTodaysPulse} via
 * the `data` prop and renders four {@link StatCard}s in a responsive
 * grid (1 col mobile → 2 col sm → 4 col lg, per SPEC §11.2 mobile
 * collapse rule and SPEC §13.1 dense visual style).
 *
 * Wired into `src/app/(app)/dashboard/page.tsx` by task 79.
 */

import * as React from 'react';
import {
  Facebook,
  Instagram,
  Linkedin,
  ListTodo,
  MessageSquare,
  Send,
  TrendingUp,
  Twitter,
  Users,
  Youtube,
  type LucideIcon,
} from 'lucide-react';
import type { SocialPlatform } from '@prisma/client';

import { StatCard, type StatCardDelta } from '@/components/shared/StatCard';

import type { TodaysPulse } from './loaders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * INR currency formatter (Indian numbering convention) used for the
 * "Ad spend" card. `style: 'currency'` produces `₹1,23,456` for
 * positive values and `-₹500` for negative values; we prepend an
 * explicit `+` for positives in delta strings.
 */
const INR_FORMATTER = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
});

/** Format an integer rupee amount as `₹1,23,456`. */
function formatInr(value: number): string {
  return INR_FORMATTER.format(value);
}

/**
 * Build a delta indicator from a numeric difference. Returns `null`
 * when the caller wants no delta rendered (we use it for `0` cases
 * that should still render — see below — so this just exists for
 * completeness).
 *
 *   - `diff > 0` → up / green / `"+5 vs yesterday"`
 *   - `diff < 0` → down / red / `"-3 vs yesterday"`
 *   - `diff === 0` → flat / muted / `"no change"`
 */
function buildCountDelta(diff: number): StatCardDelta {
  if (diff > 0) {
    return { direction: 'up', label: `+${diff} vs yesterday` };
  }
  if (diff < 0) {
    // `diff` is negative → its toString already contains the `-` sign.
    return { direction: 'down', label: `${diff} vs yesterday` };
  }
  return { direction: 'flat', label: 'no change' };
}

/** Same as {@link buildCountDelta} but formatted as an INR amount. */
function buildCurrencyDelta(diff: number): StatCardDelta {
  if (diff > 0) {
    return {
      direction: 'up',
      label: `+${formatInr(diff)} vs yesterday`,
    };
  }
  if (diff < 0) {
    // `formatInr` carries the negative sign already (`-₹500`).
    return { direction: 'down', label: `${formatInr(diff)} vs yesterday` };
  }
  return { direction: 'flat', label: 'no change' };
}

/**
 * Render a card label with a leading lucide icon. `StatCard.label`
 * accepts `ReactNode`, so we wrap the label text in an inline-flex
 * row with the icon — keeps every card visually aligned without
 * extending the StatCard primitive.
 */
function CardLabel({
  icon: Icon,
  children,
}: {
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

/**
 * Per-platform icon mapping for the "Posts published today" card.
 * Lucide ships brand icons for Instagram/Facebook/Twitter/LinkedIn/
 * YouTube but does not have a Threads glyph — fall back to the
 * generic `MessageSquare` so the row is still 6-up when Threads has
 * activity.
 *
 * Order matters — it determines the left-to-right rendering order of
 * the mini-icons row. We follow the same enum order used by
 * `loaders.ts::ALL_SOCIAL_PLATFORMS` so the dashboard stays stable.
 */
const PLATFORM_ICON_ORDER: ReadonlyArray<{
  platform: SocialPlatform;
  icon: LucideIcon;
  label: string;
}> = [
  { platform: 'INSTAGRAM', icon: Instagram, label: 'Instagram' },
  { platform: 'FACEBOOK', icon: Facebook, label: 'Facebook' },
  { platform: 'TWITTER', icon: Twitter, label: 'Twitter' },
  { platform: 'LINKEDIN', icon: Linkedin, label: 'LinkedIn' },
  { platform: 'YOUTUBE', icon: Youtube, label: 'YouTube' },
  { platform: 'THREADS', icon: MessageSquare, label: 'Threads' },
];

/**
 * Mini-icons row rendered below the "Posts published today" value —
 * one chip per platform that has a non-zero published count today.
 * Renders nothing when every platform is zero (the headline `0`
 * already conveys that).
 */
function PlatformBreakdown({
  byPlatform,
}: {
  byPlatform: TodaysPulse['postsPublishedToday']['byPlatform'];
}) {
  const active = PLATFORM_ICON_ORDER.filter(
    ({ platform }) => byPlatform[platform] > 0,
  );
  if (active.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {active.map(({ platform, icon: Icon, label }) => (
        <span key={platform} className="inline-flex items-center gap-1">
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="sr-only">{label}: </span>
          <span className="tabular-nums">{byPlatform[platform]}</span>
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface TodaysPulseProps {
  data: TodaysPulse;
}

/** Row 1 of the dashboard (SPEC §11.1) — 4 KPI cards. */
export function TodaysPulse({ data }: TodaysPulseProps) {
  const leadsDelta = data.newLeadsToday - data.newLeadsYesterday;
  const spendDelta = data.adSpendToday - data.adSpendYesterday;

  return (
    <section
      aria-label="Today's pulse"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <StatCard
        label={<CardLabel icon={Users}>New leads today</CardLabel>}
        value={data.newLeadsToday.toLocaleString('en-IN')}
        delta={buildCountDelta(leadsDelta)}
      />

      <StatCard
        label={<CardLabel icon={TrendingUp}>Ad spend today</CardLabel>}
        value={formatInr(data.adSpendToday)}
        delta={buildCurrencyDelta(spendDelta)}
      />

      <StatCard
        label={<CardLabel icon={Send}>Posts published today</CardLabel>}
        value={data.postsPublishedToday.total.toLocaleString('en-IN')}
        sparkline={
          <PlatformBreakdown
            byPlatform={data.postsPublishedToday.byPlatform}
          />
        }
      />

      <StatCard
        label={<CardLabel icon={ListTodo}>Open dev tasks</CardLabel>}
        value={data.openDevTasks.total.toLocaleString('en-IN')}
        sparkline={
          <div className="text-xs text-muted-foreground">
            <span className="tabular-nums">{data.openDevTasks.inProgress}</span>{' '}
            in progress
          </div>
        }
      />
    </section>
  );
}
