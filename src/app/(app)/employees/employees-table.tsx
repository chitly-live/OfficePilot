'use client';

/**
 * EmployeesTable — DataTable wrapper for the employees list.
 *
 * Renders the columns called out in SPEC §5.1 ("avatar, name, email,
 * role, designation, status, last active") plus an actions column with
 * a "View" link to `/employees/[id]`.
 *
 * Client component because the underlying `DataTable` uses TanStack
 * Table hooks. It receives the already-fetched + serialised list from
 * the server page and never re-fetches on its own — pagination and
 * filters are URL-driven and re-render the parent server component.
 *
 * "Last active" is approximated from `updatedAt`. The schema doesn't
 * track a separate `lastActiveAt` field (out of scope per SPEC §0),
 * and any write — login, profile edit, attendance — touches
 * `updatedAt` indirectly through cascading updates, so it's the best
 * available proxy.
 */

import * as React from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { UserPlus, Users } from 'lucide-react';
import type { Role } from '@prisma/client';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DataTable,
  type DataTableColumn,
} from '@/components/shared/DataTable';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { UserPublic } from '@/lib/schemas/users';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Two-letter avatar fallback. Same convention as the topbar's
 * `getInitials` — first letter of the first two whitespace tokens,
 * uppercased.
 */
function getInitials(name: string | null | undefined, email: string): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromEmail = email.trim()[0];
  return (fromEmail ?? '?').toUpperCase();
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

/** Maximum modules shown inline in the table cell before truncating. */
const MODULE_ACCESS_PREVIEW_LIMIT = 3;

/**
 * Human-readable summary of a user's `moduleAccess` for the table cell.
 *
 * Per the contract in `User.moduleAccess` (Prisma schema) and
 * `canAccessModule()`:
 *   • ADMIN  → "All modules" (admins ignore the column entirely).
 *   • EMPLOYEE with empty array → "All (legacy)" — the back-compat
 *     default for users who pre-date the feature, equivalent to
 *     full access.
 *   • EMPLOYEE with a non-empty subset → comma-separated, capitalised
 *     module names; truncated past {@link MODULE_ACCESS_PREVIEW_LIMIT}
 *     entries with a "+N more" suffix to keep the table dense.
 */
function summariseModuleAccess(
  role: Role,
  moduleAccess: string[] | null | undefined,
): string {
  if (role === 'ADMIN') return 'All modules';
  const list = moduleAccess ?? [];
  if (list.length === 0) return 'All (legacy)';
  const preview = list.slice(0, MODULE_ACCESS_PREVIEW_LIMIT);
  const remainder = list.length - preview.length;
  const labelled = preview.map(
    (m) => m.charAt(0).toUpperCase() + m.slice(1),
  );
  const head = labelled.join(', ');
  return remainder > 0 ? `${head} +${remainder} more` : head;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface EmployeesTableProps {
  items: UserPublic[];
}

/**
 * Tone map for the role badge. ADMIN = brand-aligned green/blue feel;
 * EMPLOYEE = neutral. Falling back through `StatusBadge`'s default
 * map would render both as `neutral` since neither key is in the
 * default `LeadStatus` / `CampaignStatus` vocabulary.
 */
const ROLE_TONE: Partial<Record<Role, 'green' | 'blue' | 'neutral'>> = {
  ADMIN: 'blue',
  EMPLOYEE: 'neutral',
};

export function EmployeesTable({ items }: EmployeesTableProps) {
  // Memoise the column array so TanStack Table's identity check
  // (used internally for memoisation) doesn't re-create it on every
  // parent render.
  const columns = React.useMemo<DataTableColumn<UserPublic>[]>(
    () => [
      {
        id: 'employee',
        header: 'Employee',
        cell: ({ row }) => {
          const u = row.original;
          return (
            <div className="flex items-center gap-3">
              <Avatar className="h-9 w-9">
                {u.avatarUrl ? (
                  <AvatarImage
                    src={u.avatarUrl}
                    alt={u.name ?? u.email}
                  />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(u.name, u.email)}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {u.name || '—'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {u.email}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: 'role',
        header: 'Role',
        cell: ({ row }) => (
          <StatusBadge<Role>
            status={row.original.role}
            toneMap={ROLE_TONE}
            label={row.original.role === 'ADMIN' ? 'Admin' : 'Employee'}
          />
        ),
      },
      {
        id: 'designation',
        header: 'Designation',
        cell: ({ row }) => (
          <span className="text-sm text-foreground">
            {row.original.designation || '—'}
          </span>
        ),
      },
      {
        id: 'moduleAccess',
        header: 'Modules',
        cell: ({ row }) => {
          const summary = summariseModuleAccess(
            row.original.role,
            row.original.moduleAccess,
          );
          const isFullAccess =
            row.original.role === 'ADMIN' ||
            (row.original.moduleAccess?.length ?? 0) === 0;
          return (
            <span
              className={
                isFullAccess
                  ? 'text-xs text-muted-foreground'
                  : 'text-xs font-medium text-foreground'
              }
              title={
                row.original.role === 'ADMIN'
                  ? 'Admins see every module regardless'
                  : (row.original.moduleAccess?.length ?? 0) === 0
                    ? 'No restriction set — sees all modules (legacy default)'
                    : (row.original.moduleAccess ?? []).join(', ')
              }
            >
              {summary}
            </span>
          );
        },
      },
      {
        id: 'joinedAt',
        header: 'Joined',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(row.original.joinedAt)}
          </span>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ row }) =>
          row.original.isActive ? (
            <StatusBadge status="ACTIVE" tone="green" label="Active" />
          ) : (
            <StatusBadge status="INACTIVE" tone="red" label="Inactive" />
          ),
      },
      {
        id: 'lastActive',
        header: 'Last active',
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate(row.original.updatedAt)}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <Button asChild variant="ghost" size="sm">
              <Link href={`/employees/${row.original.id}`}>View</Link>
            </Button>
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<UserPublic>
      columns={columns}
      data={items}
      getRowId={(row) => row.id}
      emptyStateProps={{
        icon: Users,
        title: 'No employees found',
        description:
          'Adjust the filters above or add a new team member to get started.',
        action: (
          <Button asChild size="sm">
            <Link href="/employees/new">
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              <span>Add employee</span>
            </Link>
          </Button>
        ),
      }}
    />
  );
}
