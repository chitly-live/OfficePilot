/**
 * `/settings/users` — admin-only system-users page (SPEC §12.1, item 2:
 * "Users (admin) — list, add, deactivate").
 *
 * For v1 this is intentionally a near-duplicate of `/employees`: the
 * underlying entity is the same `User` table, the API is the same
 * `/api/users` collection, and the create form lives at
 * `/employees/new`. The only meaningful differences are:
 *
 *   1. Surfaced under Settings as the "Users" tab so admins find it
 *      where SPEC §12.1 says it lives.
 *   2. Slightly different framing ("Manage system users" vs "Manage
 *      your team") — this view is about access/role management, not
 *      HR.
 *
 * Patterns are lifted directly from `src/app/(app)/employees/page.tsx`
 * (auth gate, search-param coercion through `userListQuerySchema`,
 * Prisma `where` clause, pagination href builder). The
 * `<EmployeesTable>` is reused as-is — its row "View" link points at
 * `/employees/[id]`, which is the canonical user detail page. The
 * filter bar is duplicated as `<UsersFilters>` because the original
 * hard-codes `/employees` in `router.replace`.
 *
 * URL contract:
 *   /settings/users?search=&role=ADMIN|EMPLOYEE&isActive=true|false&page=1
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus } from 'lucide-react';
import { Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import {
  userListQuerySchema,
  userPublicProjection,
  type UserPublic,
} from '@/lib/schemas/users';

import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/shared/PageHeader';
import { Pagination } from '@/components/shared/Pagination';

import { EmployeesTable } from '@/app/(app)/employees/employees-table';

import { UsersFilters } from './users-filters';

export const metadata = {
  title: 'Users · Settings',
};

// Always render fresh — the list reflects live DB state and current
// session role, and Next must not cache it across users.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Search-param coercion
// ---------------------------------------------------------------------------

/** Pick the first value when Next gives us `string[]` for a duplicated key. */
function firstValue(
  raw: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface SettingsUsersPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function SettingsUsersPage({
  searchParams,
}: SettingsUsersPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate — admin only.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/settings/users');
  }
  if (session.role !== 'ADMIN') {
    // Soft redirect rather than 403 — gives non-admins a forgiving
    // fallback if they bookmarked or follow a stale link.
    redirect('/dashboard');
  }

  // ------------------------------------------------------------------
  // 2. Parse + validate the search params with the same schema the
  //    API route uses, so client and server agree on filter coercion.
  // ------------------------------------------------------------------
  const rawParams: Record<string, string> = {};
  if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      const v = firstValue(value);
      if (v !== undefined) rawParams[key] = v;
    }
  }

  // `safeParse` so an invalid query string falls back to defaults
  // rather than 500ing the page.
  const parsed = userListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : userListQuerySchema.parse({});

  // ------------------------------------------------------------------
  // 3. Build the Prisma where clause — identical to `/employees`.
  // ------------------------------------------------------------------
  const where: Prisma.UserWhereInput = {};
  if (query.role !== undefined) where.role = query.role;
  if (query.isActive !== undefined) where.isActive = query.isActive;
  if (query.search) {
    where.OR = [
      { name: { contains: query.search, mode: 'insensitive' } },
      { email: { contains: query.search, mode: 'insensitive' } },
    ];
  }

  const skip = (query.page - 1) * query.pageSize;

  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      select: userPublicProjection,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      skip,
      take: query.pageSize,
    }),
    prisma.user.count({ where }),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Users"
        subtitle="Manage system users — invite teammates, change roles, deactivate access."
        actions={
          <Button asChild size="sm">
            {/* Reuses the existing employee create form — same `User` */}
            {/* entity, same `POST /api/users` endpoint. */}
            <Link href="/employees/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>Add user</span>
            </Link>
          </Button>
        }
      />

      <UsersFilters
        defaultSearch={query.search ?? ''}
        defaultRole={query.role ?? 'all'}
        defaultIsActive={
          query.isActive === undefined ? 'all' : String(query.isActive)
        }
      />

      <EmployeesTable items={items as UserPublic[]} />

      <Pagination
        page={query.page}
        pageSize={query.pageSize}
        total={total}
        basePath="/settings/users"
        searchParams={{
          search: query.search,
          role: query.role,
          isActive:
            query.isActive !== undefined ? String(query.isActive) : undefined,
        }}
      />
    </div>
  );
}
