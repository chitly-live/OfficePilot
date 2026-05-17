'use client';

/**
 * LeadsTable — DataTable wrapper for the leads list (SPEC §6.1).
 *
 * v0.1.4 — column set realigned to mirror the Chitly team's existing
 * lead spreadsheet so admins can scan the table without re-learning the
 * layout. Columns in order:
 *
 *   Date · Name · WhatsApp · Address · Age · Active Since · Language
 *   · Extra Details · Phone Type · Status · Owner · (actions)
 *
 * `Status` and `Owner` are kept (OfficePilot workflow lens) but
 * `Company`, `Source`, `Priority`, `Value`, and `Next follow-up` are
 * dropped from the default view — they're still on the detail page and
 * still filterable in the filters bar.
 *
 * On screens < md we collapse the rows into a 2-line card stack:
 *   line 1 → Name + WhatsApp icon
 *   line 2 → Address · Age · Phone Type
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. It receives the already-fetched + serialised list from
 * the server page and never re-fetches on its own.
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { BanIcon, Phone as PhoneIcon, Plus, UserSearch } from 'lucide-react';
import type { LeadStatus } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { LeadPublic } from '@/lib/schemas/leads';

// ---------------------------------------------------------------------------
// Local row shape
// ---------------------------------------------------------------------------

/**
 * The 7 v0.1.4 spreadsheet fields land on `LeadPublic` once the
 * parallel schema agent's migration to `leadPublicProjection` ships.
 * Until both branches merge, we use a structural extension type so the
 * UI can be written against the final shape without touching the
 * shared schema file.
 */
export type LeadRow = LeadPublic & {
  age?: number | null;
  activeSince?: string | null;
  languages?: string[];
  extraDetails?: string | null;
  phoneType?: string | null;
  notOnWhatsapp?: boolean;
  address?: string | null;
};

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
 * Format a Date (or ISO string) as `dd-MMM-yyyy` (e.g. `31-Jan-2026`)
 * — matches the user's spreadsheet date convention. Returns `—` when
 * the input is falsy / un-parseable so the table never shows
 * "Invalid Date".
 */
function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return format(date, 'dd-MMM-yyyy');
}

/** Truncate a string to `max` chars (keeping whole words when easy)
 *  and append an ellipsis. Returns the original when within bounds. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * The spreadsheet's "Address" column should fall back to the legacy
 * `city` value for older leads that haven't been re-captured against
 * the new multi-line `address` field yet.
 */
function pickAddress(lead: LeadRow): string | null {
  const addr = (lead.address ?? '').trim();
  if (addr !== '') return addr;
  const city = (lead.city ?? '').trim();
  return city !== '' ? city : null;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface LeadsTableProps {
  items: LeadPublic[];
}

export function LeadsTable({ items }: LeadsTableProps) {
  // Treat the incoming rows as `LeadRow` — the new fields are optional
  // so this is a safe widening cast (older rows just render as `—`).
  const rows = items as LeadRow[];

  // Memoise the column array so TanStack Table's identity check
  // doesn't re-create it on every parent render.
  const columns = React.useMemo<DataTableColumn<LeadRow>[]>(
    () => [
      {
        id: 'createdAt',
        header: 'Date',
        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-muted-foreground tabular-nums">
            {formatDate(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: 'name',
        header: 'Name',
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
              {lead.email ? (
                <div className="truncate text-xs text-muted-foreground">
                  {lead.email}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'whatsapp',
        header: 'WhatsApp',
        cell: ({ row }) => {
          const lead = row.original;
          const phone = lead.phone?.trim() ?? '';
          const blocked = lead.notOnWhatsapp === true;
          if (blocked) {
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
                      <BanIcon
                        className="h-4 w-4 text-destructive"
                        aria-hidden="true"
                      />
                      <span className="line-through">
                        {phone === '' ? '—' : phone}
                      </span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>Not on WhatsApp</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          }
          if (phone === '') {
            return <span className="text-sm text-muted-foreground">—</span>;
          }
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-foreground">
              <PhoneIcon
                className="h-3.5 w-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              <span className="tabular-nums">{phone}</span>
            </span>
          );
        },
      },
      {
        id: 'address',
        header: 'Address',
        cell: ({ row }) => {
          const addr = pickAddress(row.original);
          if (!addr) {
            return <span className="text-sm text-muted-foreground">—</span>;
          }
          const short = truncate(addr, 30);
          if (short === addr) {
            return <span className="text-sm text-foreground">{addr}</span>;
          }
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-sm text-foreground">
                    {short}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-pre-wrap">
                  {addr}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        id: 'age',
        header: () => <span className="block text-right">Age</span>,
        cell: ({ row }) => {
          const age = row.original.age;
          if (age === null || age === undefined) {
            return (
              <span className="block text-right text-sm text-muted-foreground">
                —
              </span>
            );
          }
          return (
            <span className="block text-right text-sm tabular-nums text-foreground">
              {age}
            </span>
          );
        },
      },
      {
        id: 'activeSince',
        header: 'Active Since',
        cell: ({ row }) => {
          const v = row.original.activeSince?.trim() ?? '';
          if (v === '') {
            return (
              <span className="text-sm italic text-muted-foreground">—</span>
            );
          }
          return (
            <span className="whitespace-nowrap text-sm text-foreground">
              {v}
            </span>
          );
        },
      },
      {
        id: 'languages',
        header: 'Language',
        cell: ({ row }) => {
          const langs = row.original.languages ?? [];
          if (langs.length === 0) {
            return <span className="text-sm text-muted-foreground">—</span>;
          }
          return (
            <div className="flex flex-wrap gap-1">
              {langs.map((l) => (
                <Badge key={l} variant="secondary" className="font-normal">
                  {l}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        id: 'extraDetails',
        header: 'Extra Details',
        cell: ({ row }) => {
          const v = row.original.extraDetails?.trim() ?? '';
          if (v === '') {
            return <span className="text-sm text-muted-foreground">—</span>;
          }
          const short = truncate(v, 40);
          if (short === v) {
            return (
              <span className="text-sm text-muted-foreground">{v}</span>
            );
          }
          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-help text-sm text-muted-foreground">
                    {short}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs whitespace-pre-wrap">
                  {v}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        id: 'phoneType',
        header: 'Phone Type',
        cell: ({ row }) => {
          const v = row.original.phoneType?.trim() ?? '';
          if (v === '') {
            return <span className="text-sm text-muted-foreground">—</span>;
          }
          return (
            <Badge variant="secondary" className="font-normal">
              {v}
            </Badge>
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

  // ------------------------------------------------------------------
  // Mobile card layout (< md). The DataTable renders the desktop view
  // on its own; we mount a sibling card list and toggle visibility
  // with Tailwind's `md:hidden` / `hidden md:block` pair.
  // ------------------------------------------------------------------
  const mobileEmpty = rows.length === 0;

  return (
    <>
      <div className="hidden md:block">
        <DataTable<LeadRow>
          columns={columns}
          data={rows}
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
      </div>

      <div className="md:hidden">
        {mobileEmpty ? (
          <div className="rounded-md border bg-card p-6 text-center text-sm text-muted-foreground">
            No leads found. Adjust the filters above or{' '}
            <Link href="/leads/new" className="text-foreground underline">
              add a new lead
            </Link>
            .
          </div>
        ) : (
          <ul className="divide-y rounded-md border bg-card">
            {rows.map((lead) => {
              const phone = lead.phone?.trim() ?? '';
              const blocked = lead.notOnWhatsapp === true;
              const addr = pickAddress(lead);
              const age = lead.age;
              const pType = lead.phoneType?.trim() ?? '';
              const parts: string[] = [];
              if (addr) parts.push(truncate(addr, 30));
              if (age !== null && age !== undefined) parts.push(`Age ${age}`);
              if (pType !== '') parts.push(pType);
              return (
                <li key={lead.id} className="px-3 py-3">
                  <Link
                    href={`/leads/${lead.id}`}
                    className="block space-y-1"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-sm font-medium text-foreground">
                        {lead.name}
                      </span>
                      {blocked ? (
                        <BanIcon
                          className="h-4 w-4 shrink-0 text-destructive"
                          aria-label="Not on WhatsApp"
                        />
                      ) : phone !== '' ? (
                        <span className="inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground">
                          <PhoneIcon className="h-3 w-3" aria-hidden="true" />
                          {phone}
                        </span>
                      ) : null}
                    </div>
                    {parts.length > 0 ? (
                      <div className="truncate text-xs text-muted-foreground">
                        {parts.join(' · ')}
                      </div>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
