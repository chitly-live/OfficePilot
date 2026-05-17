'use client';

/**
 * CampaignLeadsList — auto-linked leads for a campaign (SPEC §7.2.3).
 *
 * Displays leads whose `utmCampaign` matches the campaign's own UTM
 * tag. The parent server page fetches the first page directly via
 * Prisma (so the initial render needs no client-side round-trip);
 * this client component renders the list.
 *
 * For now we render a simple read-only list — paging beyond the
 * initial page is not part of task 45 (the API endpoint exists for
 * future work). The empty state explains how to start linking leads
 * (set a `utm_campaign` tag and capture leads from a tagged URL).
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Megaphone } from 'lucide-react';
import type { LeadStatus } from '@prisma/client';

import {
  Card,
  CardContent,
} from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { LeadPublic } from '@/lib/schemas/leads';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value)}`;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface CampaignLeadsListProps {
  /** Page of leads, already filtered to the campaign's UTM tag. */
  items: LeadPublic[];
  /** Total count across all pages, used in the summary line. */
  total: number;
  /** Whether the campaign has a `utmCampaign` tag set. When false,
   *  no leads can ever be auto-linked — we surface that explicitly. */
  hasUtmTag: boolean;
}

export function CampaignLeadsList({
  items,
  total,
  hasUtmTag,
}: CampaignLeadsListProps) {
  if (!hasUtmTag) {
    return (
      <EmptyState
        icon={Megaphone}
        title="No UTM tag set"
        description="Set a utm_campaign on this campaign to auto-link leads captured from URLs carrying the same tag."
      />
    );
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Megaphone}
        title="No leads linked yet"
        description="Leads captured with a matching utm_campaign will appear here automatically."
      />
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Showing the most recent {items.length} of {total} linked
        {total === 1 ? ' lead' : ' leads'}.
      </p>
      <ol className="space-y-2" aria-label="Linked leads">
        {items.map((lead) => (
          <li key={lead.id}>
            <Card>
              <CardContent className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 space-y-0.5">
                  <Link
                    href={`/leads/${lead.id}`}
                    className="truncate text-sm font-medium text-foreground hover:underline"
                  >
                    {lead.name}
                  </Link>
                  <div className="truncate text-xs text-muted-foreground">
                    {lead.email || lead.phone || '—'}
                    {lead.company ? ` · ${lead.company}` : ''}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs">
                  <StatusBadge<LeadStatus> status={lead.status} />
                  <span className="tabular-nums text-muted-foreground">
                    {formatInr(lead.value)}
                  </span>
                  <span className="text-muted-foreground">
                    {formatDate(lead.createdAt)}
                  </span>
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ol>
    </div>
  );
}
