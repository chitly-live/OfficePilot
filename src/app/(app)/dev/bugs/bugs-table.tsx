'use client';

/**
 * DevBugsTable — DataTable wrapper for the bug inbox (SPEC.md §9.2.2).
 *
 * Columns:
 *   • title (with description preview)
 *   • status badge
 *   • priority badge
 *   • affects version
 *   • assignee (avatar + name)
 *   • reporter (avatar + name)
 *   • created date
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. Receives the already-fetched + serialised list from
 * the server page.
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Bug } from 'lucide-react';
import type { DevTaskStatus, Priority } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { DevTaskPublic, DevTaskUserEmbed } from '@/lib/schemas/dev';

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

function UserCell({ user }: { user: DevTaskUserEmbed | null | undefined }) {
  if (!user) {
    return <span className="text-sm italic text-muted-foreground">—</span>;
  }
  return (
    <div className="flex items-center gap-2">
      <Avatar className="h-7 w-7">
        {user.avatarUrl ? (
          <AvatarImage src={user.avatarUrl} alt={user.name} />
        ) : null}
        <AvatarFallback className="bg-brand-100 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
          {getInitials(user.name, user.email)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate text-sm text-foreground">
        {user.name || user.email}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface DevBugsTableProps {
  items: DevTaskPublic[];
}

export function DevBugsTable({ items }: DevBugsTableProps) {
  const columns = React.useMemo<DataTableColumn<DevTaskPublic>[]>(
    () => [
      {
        id: 'title',
        header: 'Bug',
        cell: ({ row }) => {
          const task = row.original;
          return (
            <div className="min-w-0">
              <div className="truncate text-sm font-medium text-foreground">
                {task.title}
              </div>
              {task.description ? (
                <div className="truncate text-xs text-muted-foreground">
                  {task.description}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) => (
          <StatusBadge<DevTaskStatus> status={row.original.status} />
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
        id: 'affectsVersion',
        header: 'Affects version',
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.affectsVersion ?? '—'}
          </span>
        ),
      },
      {
        id: 'assignee',
        header: 'Assignee',
        cell: ({ row }) => <UserCell user={row.original.assignee} />,
      },
      {
        id: 'reporter',
        header: 'Reporter',
        cell: ({ row }) => <UserCell user={row.original.reporter} />,
      },
      {
        id: 'createdAt',
        header: 'Created',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(row.original.createdAt)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<DevTaskPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Bug,
        title: 'No bugs found',
        description:
          'Adjust the filters above, or log a bug to start your inbox.',
        action: (
          <Button asChild size="sm">
            <Link href="/dev/new?type=BUG">
              <Bug className="h-4 w-4" aria-hidden="true" />
              <span>Log a bug</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
