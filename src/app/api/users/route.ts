/**
 * `GET /api/users` and `POST /api/users` — admin-only user CRUD.
 *
 * Per SPEC.md §5.3, the `/api/users` collection is admin-gated:
 *
 *   GET  /api/users  → list employees with search, role, isActive filters
 *                      and pagination. Admin-only.
 *   POST /api/users  → create a new employee. Admin-only.
 *
 * The middleware (`src/middleware.ts`) already restricts `/api/users/*`
 * to ADMIN sessions, but the handler also enforces the role check
 * defensively via `requireAdminSession()` — middleware can be reordered
 * or excluded in the future, and the route should remain safe regardless.
 *
 * Response shape for GET:
 *
 *   {
 *     items: UserPublic[],
 *     total: number,
 *     page: number,
 *     pageSize: number
 *   }
 *
 * Response shape for POST: a single `UserPublic` object (the projection
 * deliberately omits `passwordHash` per SPEC.md §2.2 / §12.2).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { hash } from 'bcryptjs';
import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  parseSearchParams,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  userCreateSchema,
  userListQuerySchema,
  userPublicProjection,
  type UserPublic,
} from '@/lib/schemas/users';

// Bcrypt cost factor 12 per SPEC.md §2.2 ("password (bcrypt hashed,
// cost factor 12)"). Pinned as a const here so the value is grep-able
// from the spec.
const BCRYPT_COST = 12;

// Force the Node runtime — bcryptjs is fine on Edge in theory, but
// Prisma definitely is not. Both POST (bcrypt + Prisma) and GET (Prisma)
// must run on Node.
export const runtime = 'nodejs';

// Each request must hit the database; never serve a cached list.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// GET /api/users — paginated list
// ---------------------------------------------------------------------------

/**
 * List employees, filterable by `role`, `isActive`, and a free-text
 * `search` over `name` and `email`. Pagination via `page` + `pageSize`.
 *
 * The user-facing `/employees` page (task 28) drives this with all
 * fields optional. Defaults: `page=1`, `pageSize=50`. See
 * {@link userListQuerySchema} for the contract.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    await requireAdminSession();

    const query = parseSearchParams(req.nextUrl.searchParams, userListQuerySchema);

    // Build the Prisma `where` from whichever filters were supplied.
    // Each branch is conditional so an absent filter never leaks an
    // `undefined` into the WHERE clause.
    const where: Prisma.UserWhereInput = {};
    if (query.role !== undefined) {
      where.role = query.role;
    }
    if (query.isActive !== undefined) {
      where.isActive = query.isActive;
    }
    if (query.search) {
      // Postgres supports `mode: 'insensitive'` natively; this gives us
      // a case-insensitive `contains` over both name and email without
      // a custom collation.
      where.OR = [
        { name: { contains: query.search, mode: 'insensitive' } },
        { email: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const skip = (query.page - 1) * query.pageSize;

    // `findMany` + `count` in parallel — they share the same `where`
    // and there's no transactional invariant between them, so a single
    // round-trip via `Promise.all` is the right call.
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

    return NextResponse.json({
      items: items as UserPublic[],
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// POST /api/users — create
// ---------------------------------------------------------------------------

/**
 * Create a new user. Admin-only.
 *
 * Flow:
 *   1. Validate body with `userCreateSchema` (lower-cases email,
 *      enforces password length, etc.).
 *   2. Hash password with bcryptjs at cost 12 — the column is
 *      `passwordHash`, the plain-text never touches the DB.
 *   3. Insert via Prisma. Translate `P2002` (unique email) to a 409.
 *   4. Log `user.created` to ActivityLog (best-effort — logging
 *      failures must not fail a successful creation).
 *   5. Return the new user via the public projection (no `passwordHash`).
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const input = await parseJsonBody(req, userCreateSchema);

    const passwordHash = await hash(input.password, BCRYPT_COST);

    // Normalise moduleAccess: ADMIN users always see every module, so
    // storing a per-module whitelist on an admin row is dead weight and
    // would just confuse a future "which modules can Alice see?" query.
    // Zod gives us an `[]` default for EMPLOYEE which is the legacy
    // "all modules" sentinel; for ADMIN we collapse any non-empty input
    // back to `[]` so the DB state stays clean and the field's "ADMIN
    // ignores this column" invariant is enforced at the write site.
    const moduleAccess =
      input.role === 'ADMIN' ? [] : (input.moduleAccess ?? []);

    const user = await prisma.user.create({
      data: {
        email: input.email,
        passwordHash,
        name: input.name,
        role: input.role,
        // Only include optional fields when provided so Prisma uses the
        // schema defaults (e.g. `isActive=true`) rather than `null`.
        ...(input.phone !== undefined ? { phone: input.phone } : {}),
        ...(input.designation !== undefined ? { designation: input.designation } : {}),
        ...(input.avatarUrl !== undefined ? { avatarUrl: input.avatarUrl } : {}),
        joinedAt: input.joinedAt,
        moduleAccess,
      },
      select: userPublicProjection,
    });

    // Best-effort audit log. `logActivity` propagates errors by design
    // (see `src/lib/activity.ts`), so wrap it here to keep the route's
    // happy path resilient.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.USER_CREATED,
        entityType: 'user',
        entityId: user.id,
        metadata: {
          entityName: user.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/users] activity log failed', logErr);
    }

    return NextResponse.json(user as UserPublic, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
