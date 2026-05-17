/**
 * `/employees` — admin-only employees list (SPEC §5.1).
 *
 * Server Component. Responsibilities:
 *
 *   1. Authorisation: only ADMIN sessions reach this page. The
 *      middleware already guards `/api/users` (admin-only collection
 *      ops), but `/employees` itself is page-level admin-gated per
 *      SPEC §5.4 ("Non-admin cannot access /employees/new"). We
 *      enforce that here AND on `/new` so a deep link or a stale
 *      cache can't sneak past.
 *   2. Data: query Prisma directly with the same filter shape the
 *      `GET /api/users` API route uses. Per Next.js App Router
 *      guidance we don't round-trip through our own HTTP API from a
 *      Server Component — Prisma is already on the same process.
 *      Filters and pagination are URL-driven so the back button and
 *      deep links work as expected.
 *   3. Render: PageHeader + filters + `<EmployeesTable>` (client) +
 *      Pagination. The client table receives a fully-serialised list
 *      and renders the DataTable with column-level `cell` renderers.
 *
 * URL contract:
 *   /employees?search=&role=ADMIN|EMPLOYEE&isActive=true|false&page=1
 *
 * Filters live in the URL so refreshing or sharing a link replays
 * exactly the same view.
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

import { EmployeesFilters } from './employees-filters';
import { EmployeesTable } from './employees-table';

export const metadata = {
  title: 'Employees',
};

// Always render fresh — the list reflects live DB state and current
// session role, and Next must not cache it across users.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Search-param coercion
// ---------------------------------------------------------------------------

/**
 * Next.js 14 page props receive `searchParams` as
 * `{ [key: string]: string | string[] | undefined }`. Only the first
 * value of any duplicated key is honoured — same convention as
 * `parseSearchParams` in `@/lib/api-helpers`.
 */
function firstValue(
  raw: string | string[] | undefined,
): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

// ---------------------------------------------------------------------------
// Page props
// ---------------------------------------------------------------------------

interface EmployeesPageProps {
  searchParams?: Record<string, string | string[] | undefined>;
}

export default async function EmployeesPage({
  searchParams,
}: EmployeesPageProps) {
  // ------------------------------------------------------------------
  // 1. Auth gate — admin only.
  // ------------------------------------------------------------------
  const session = await auth();
  if (!session?.userId) {
    redirect('/login?callbackUrl=/employees');
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
  // rather than 500ing the page. We surface the errors silently —
  // bad URLs are user-correctable.
  const parsed = userListQuerySchema.safeParse(rawParams);
  const query = parsed.success
    ? parsed.data
    : userListQuerySchema.parse({}); // defaults only

  // ------------------------------------------------------------------
  // 3. Build the Prisma where clause — identical shape to the API
  //    route in `src/app/api/users/route.ts`.
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
        title="Employees"
        subtitle="Manage your team — search, filter, and review activity."
        actions={
          <Button asChild size="sm">
            <Link href="/employees/new">
              <Plus className="h-4 w-4" aria-hidden="true" />
              <span>New employee</span>
            </Link>
          </Button>
        }
      />

      <EmployeesFilters
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
        basePath="/employees"
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
