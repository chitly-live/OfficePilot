'use client';

/**
 * CampaignsTable — DataTable wrapper for the campaigns list (SPEC §7.1).
 *
 * Columns:
 *   • name (link to detail)
 *   • channel
 *   • status badge
 *   • owner (avatar + name)
 *   • budget (₹ formatted)
 *   • spent (₹ formatted)
 *   • spent% bar (spent/budget)
 *   • conversions
 *   • conversionRate% (conversions/signups)
 *   • actions (link to detail)
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. Receives the already-fetched + serialised list from
 * the server page.
 */

import * as React from 'react';
import Link from 'next/link';
import { Megaphone, Plus } from 'lucide-react';
import type { CampaignChannel, CampaignStatus } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { CampaignPublic } from '@/lib/schemas/campaigns';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-letter avatar fallback. */
function getInitials(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromFallback = fallback.trim()[0];
  return (fromFallback ?? '?').toUpperCase();
}

/**
 * Format an INR value with the Indian numbering convention. Returns
 * `—` for null/undefined so the empty cell is unambiguous.
 */
function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

/** Friendly display label for `CampaignChannel`. */
const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  INSTAGRAM_ORGANIC: 'Instagram Organic',
  YOUTUBE: 'YouTube',
  INFLUENCER: 'Influencer',
  EMAIL: 'Email',
  OTHER: 'Other',
};

/**
 * Compute spend/budget percentage as `[0, ∞)`. Caller decides how to
 * cap the visual bar — we cap it at 100 % for the width but show the
 * raw % in the tooltip text so over-budget campaigns are visible.
 */
function spentPercent(spent: number, budget: number): number {
  if (!Number.isFinite(spent) || !Number.isFinite(budget)) return 0;
  if (budget <= 0) return 0;
  return Math.max(0, (spent / budget) * 100);
}

/**
 * Compute conversion rate as `[0, 1]`. Returns `null` when there are
 * no signups — division by zero is undefined and shouldn't render.
 */
function conversionRate(
  conversions: number,
  signups: number,
): number | null {
  if (signups <= 0) return null;
  if (!Number.isFinite(conversions) || !Number.isFinite(signups)) return null;
  return conversions / signups;
}

/** Format a 0–1 rate as a 0–100 % string with one decimal. */
function formatRate(value: number | null): string {
  if (value === null) return '—';
  return `${(value * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface CampaignsTableProps {
  items: CampaignPublic[];
}

export function CampaignsTable({ items }: CampaignsTableProps) {
  const columns = React.useMemo<DataTableColumn<CampaignPublic>[]>(
    () => [
      {
        id: 'name',
        header: 'Campaign',
        cell: ({ row }) => {
          const c = row.original;
          return (
            <div className="min-w-0">
              <Link
                href={`/marketing/${c.id}`}
                className="truncate text-sm font-medium text-foreground hover:underline"
              >
                {c.name}
              </Link>
              {c.utmCampaign ? (
                <div className="truncate font-mono text-xs text-muted-foreground">
                  utm: {c.utmCampaign}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'channel',
        header: 'Channel',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {CHANNEL_LABELS[row.original.channel]}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <StatusBadge<CampaignStatus> status={row.original.status} />
        ),
      },
      {
        id: 'owner',
        header: 'Owner',
        cell: ({ row }) => {
          const owner = row.original.owner;
          if (!owner) {
            return (
              <span className="text-sm text-muted-foreground">Unassigned</span>
            );
          }
          return (
            <div className="flex items-center gap-2">
              <Avatar className="h-7 w-7">
                {owner.avatarUrl ? (
                  <AvatarImage src={owner.avatarUrl} alt={owner.name} />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(owner.name, owner.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-sm text-foreground">
                {owner.name || owner.email}
              </span>
            </div>
          );
        },
      },
      {
        id: 'budget',
        header: () => <span className="block text-right">Budget</span>,
        cell: ({ row }) => (
          <span className="block text-right font-medium tabular-nums text-foreground">
            {formatInr(row.original.budget)}
          </span>
        ),
      },
      {
        id: 'spent',
        header: () => <span className="block text-right">Spent</span>,
        cell: ({ row }) => (
          <span className="block text-right font-medium tabular-nums text-foreground">
            {formatInr(row.original.spent)}
          </span>
        ),
      },
      {
        id: 'spentPct',
        header: 'Spend %',
        cell: ({ row }) => {
          const c = row.original;
          const pct = spentPercent(c.spent, c.budget);
          // Visual width clamped at 100 %; raw % shown in the
          // tooltip + label so over-budget runs aren't hidden.
          const clamped = Math.min(100, pct);
          const overBudget = pct > 100;
          return (
            <div
              className="flex w-32 items-center gap-2"
              title={`${pct.toFixed(1)}% of budget`}
            >
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full transition-all',
                    overBudget
                      ? 'bg-status-red'
                      : pct >= 80
                        ? 'bg-status-amber'
                        : 'bg-status-green',
                  )}
                  style={{ width: `${clamped}%` }}
                />
              </div>
              <span
                className={cn(
                  'w-12 shrink-0 text-right text-xs tabular-nums',
                  overBudget
                    ? 'text-status-red'
                    : 'text-muted-foreground',
                )}
              >
                {pct.toFixed(0)}%
              </span>
            </div>
          );
        },
      },
      {
        id: 'conversions',
        header: () => <span className="block text-right">Conversions</span>,
        cell: ({ row }) => (
          <span className="block text-right font-medium tabular-nums text-foreground">
            {row.original.conversions.toLocaleString('en-IN')}
          </span>
        ),
      },
      {
        id: 'conversionRate',
        header: () => (
          <span className="block text-right">Conversion %</span>
        ),
        cell: ({ row }) => {
          const c = row.original;
          const rate = conversionRate(c.conversions, c.signups);
          return (
            <span className="block text-right text-sm tabular-nums text-muted-foreground">
              {formatRate(rate)}
            </span>
          );
        },
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/marketing/${row.original.id}`}>View</Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<CampaignPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Megaphone,
        title: 'No campaigns found',
        description:
          'Adjust the filters above, or create your first campaign to start tracking spend and signups.',
        action: (
          <Button asChild size="sm">
            <Link href="/marketing/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>New campaign</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
