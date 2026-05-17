'use client';

/**
 * LeadsTable — DataTable wrapper for the leads list (SPEC §6.1).
 *
 * Columns called out in the task brief:
 *   • name
 *   • company
 *   • owner avatar + name
 *   • status badge
 *   • source
 *   • priority
 *   • value (₹ formatted)
 *   • nextFollowUpAt
 *   • actions (link to detail)
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. It receives the already-fetched + serialised list
 * from the server page and never re-fetches on its own — pagination
 * and filters are URL-driven and re-render the parent server
 * component.
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Plus, UserSearch } from 'lucide-react';
import type { LeadSource, LeadStatus, Priority } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { LeadPublic } from '@/lib/schemas/leads';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Two-letter avatar fallback. Matches the convention used by the
 * employees table.
 */
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
 * Format a Date (or ISO string) as `dd MMM yyyy`. Returns `—` when
 * the input is falsy / un-parseable so the table never shows
 * "Invalid Date".
 */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd MMM yyyy');
}

/**
 * Format an INR value with the Indian numbering convention
 * (₹1,23,45,678). Returns `—` for null/undefined so the empty cell
 * is unambiguous.
 */
function formatInr(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  if (!Number.isFinite(value)) return '—';
  return `₹${new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value)}`;
}

/** Friendly display label for `LeadSource`. */
const SOURCE_LABELS: Record<LeadSource, string> = {
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
// Public component
// ---------------------------------------------------------------------------

export interface LeadsTableProps {
  items: LeadPublic[];
}

export function LeadsTable({ items }: LeadsTableProps) {
  // Memoise the column array so TanStack Table's identity check
  // doesn't re-create it on every parent render.
  const columns = React.useMemo<DataTableColumn<LeadPublic>[]>(
    () => [
      {
        id: 'name',
        header: 'Lead',
        cell: ({ row }) => {
          const lead = row.original;
          return (
            <div className="min-w-0">
              <Link
                href={`/leads/${lead.id}`}
                className="truncate text-sm font-medium text-foreground hover:underline"
              >
                {lead.name}
              </Link>
              <div className="truncate text-xs text-muted-foreground">
                {lead.email || lead.phone || '—'}
              </div>
            </div>
          );
        },
      },
      {
        id: 'company',
        header: 'Company',
        cell: ({ row }) => (
          <span className="text-sm text-foreground">
            {row.original.company || '—'}
          </span>
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
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <StatusBadge<LeadStatus> status={row.original.status} />
        ),
      },
      {
        id: 'source',
        header: 'Source',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {SOURCE_LABELS[row.original.source]}
          </span>
        ),
      },
      {
        id: 'priority',
        header: 'Priority',
        cell: ({ row }) => (
          <StatusBadge<Priority> status={row.original.priority} />
        ),
      },
      {
        id: 'value',
        header: () => <span className="block text-right">Value</span>,
        cell: ({ row }) => (
          <span className="block text-right font-medium tabular-nums text-foreground">
            {formatInr(row.original.value)}
          </span>
        ),
      },
      {
        id: 'nextFollowUpAt',
        header: 'Next follow-up',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(row.original.nextFollowUpAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/leads/${row.original.id}`}>View</Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<LeadPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: UserSearch,
        title: 'No leads found',
        description:
          'Adjust the filters above, or add a new lead to start your pipeline.',
        action: (
          <Button asChild size="sm">
            <Link href="/leads/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>New lead</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
