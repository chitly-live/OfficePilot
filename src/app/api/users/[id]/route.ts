/**
 * `GET`, `PATCH`, and `DELETE` for `/api/users/[id]` (SPEC.md §5.3).
 *
 * This is the per-user endpoint for the Employees module. Authorization
 * splits per verb:
 *
 *   GET    /api/users/[id]   →  Authenticated. Admin can fetch anyone;
 *                               employee can fetch their own profile only.
 *   PATCH  /api/users/[id]   →  Admin can update anyone (any field, role,
 *                               isActive included). Employee can update
 *                               only their OWN profile, and only the
 *                               "safe" fields: name, phone, designation,
 *                               avatarUrl, password. Any attempt by an
 *                               employee to change role / isActive / email
 *                               is rejected with 403.
 *   DELETE /api/users/[id]   →  Admin only. Soft-delete (sets `isActive
 *                               = false`) — Lead.createdById is
 *                               RESTRICT, so a hard delete would orphan
 *                               historical records (SPEC.md §3, design.md
 *                               "Data Models"). Refuses to deactivate
 *                               self so an admin can't accidentally
 *                               lock themselves out of the system.
 *
 * All three handlers go through `userPublicProjection` for any user
 * data they return, so `passwordHash` never crosses the API boundary
 * (SPEC.md §2.2 / §12.2). Errors funnel through the shared
 * `errorResponse` mapper for uniform JSON shape.
 *
 * Activity logging:
 *   • Successful PATCH that does not deactivate → `user.updated`.
 *   • Successful PATCH that flips `isActive` from `true` → `false`
 *     → `user.deactivated`.
 *   • Successful DELETE → `user.deactivated`.
 *
 * Logging is best-effort (try/catch) so a missing audit row never
 * tanks an otherwise successful write (SPEC.md §14).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { hash } from 'bcryptjs';

import { prisma } from '@/lib/db';
import {
  errorResponse,
  parseJsonBody,
  requireAdminSession,
  requireSession,
} from '@/lib/api-helpers';
import { PermissionError } from '@/lib/permissions';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  userPublicProjection,
  userUpdateSchema,
  type UserPublic,
} from '@/lib/schemas/users';

// Bcrypt cost factor 12 per SPEC.md §2.2 — matches the value used in
// `POST /api/users` (task 25) and the seeder. Pinned as a const so the
// number is grep-able from the spec.
const BCRYPT_COST = 12;

// Force the Node runtime — bcryptjs and Prisma require it. `force-dynamic`
// keeps Next from caching the response of an authenticated GET.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

/**
 * Next.js 14 App Router dynamic-segment context shape for `[id]`.
 */
interface RouteContext {
  params: { id: string };
}

/**
 * Whitelist of fields an EMPLOYEE is allowed to change on their own
 * profile (SPEC.md §5.3 — "admin OR self for limited fields").
 *
 * Anything outside this set — `role`, `isActive`, `email`, `joinedAt`,
 * `moduleAccess` — is admin-only and a 403 if an employee tries to set
 * it. We guard with a typed key set so any future schema additions
 * surface here.
 */
const EMPLOYEE_SELF_EDITABLE_FIELDS = new Set<string>([
  'name',
  'phone',
  'designation',
  'avatarUrl',
  'password',
]);

/**
 * Multiset equality on two `moduleAccess` arrays. Used to decide whether
 * an admin PATCH actually changed the whitelist — order doesn't matter
 * (the UI may emit in any order) but membership does.
 */
function moduleAccessEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// GET /api/users/[id]
// ---------------------------------------------------------------------------

/**
 * Return one user. Auth: admin can fetch anyone; employee only self.
 *
 * Returns 404 when the target row doesn't exist (we use `findUnique` and
 * map a `null` into a `not_found` 404 ourselves so the response shape
 * stays consistent with `errorResponse`'s Prisma `P2025` mapping).
 */
export async function GET(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;

    // Authorization: an EMPLOYEE may only read their own row. ADMIN
    // is allowed unconditionally. We use the typed `PermissionError`
    // so the 403 response is shaped identically to other handlers.
    if (session.role !== 'ADMIN' && session.userId !== id) {
      throw new PermissionError('read', 'user');
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: userPublicProjection,
    });

    if (!user) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json(user as UserPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// PATCH /api/users/[id]
// ---------------------------------------------------------------------------

/**
 * Partial update.
 *
 * Authorization rules:
 *   • Admin              → can update any user, including `role` and
 *                          `isActive` (the soft-delete toggle).
 *   • Employee (self)    → can only set fields in
 *                          {@link EMPLOYEE_SELF_EDITABLE_FIELDS}. Any
 *                          attempt to set `role`, `isActive`, `email`,
 *                          or `joinedAt` is rejected with 403.
 *   • Employee (other)   → 403 outright.
 *
 * Special handling:
 *   • `password`, when present, is bcrypt-hashed at cost 12 before
 *     persistence; the input field is dropped and replaced with
 *     `passwordHash` on the Prisma `data` object.
 *   • `isActive: false` triggers an extra guard: an admin cannot
 *     deactivate themselves (would lock them out, see SPEC.md §2.1).
 *   • Email collisions raise Prisma `P2002`, which `errorResponse`
 *     maps to 409 `{ error: 'conflict', target: ['email'] }`.
 *   • Activity log: `user.deactivated` when the call flips
 *     `isActive` from `true` to `false`; `user.updated` otherwise.
 */
export async function PATCH(
  req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = context.params;
    const isSelf = session.userId === id;
    const isAdmin = session.role === 'ADMIN';

    // Coarse role gate: only admin or the user themselves can patch
    // a user record. Reject anything else without even reading the
    // body so a brute-force scan can't enumerate field allowances.
    if (!isAdmin && !isSelf) {
      throw new PermissionError('write', 'user');
    }

    const input = await parseJsonBody(req, userUpdateSchema);

    // Field-level gate for employee self-edits. We check this on the
    // raw parsed input (BEFORE password hashing) so the rejection
    // message references the field the client actually sent.
    if (!isAdmin) {
      for (const key of Object.keys(input)) {
        if (!EMPLOYEE_SELF_EDITABLE_FIELDS.has(key)) {
          // Re-use the canonical PermissionError so the 403 response
          // shape stays uniform across "wrong role" and "field not
          // permitted" failures.
          throw new PermissionError('write', 'user');
        }
      }
    }

    // Look up the target so we can detect (a) the existence (404 path),
    // (b) an `isActive` flip for activity logging, (c) the
    // self-deactivation safeguard for admins, and (d) the previous
    // `moduleAccess` value so we can emit a `user.module_access_changed`
    // activity row when it actually changes.
    const existing = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        isActive: true,
        role: true,
        moduleAccess: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Self-deactivation guard: an admin cannot lock themselves out by
    // setting `isActive: false` on their own row. Employees never get
    // here because `isActive` is not in EMPLOYEE_SELF_EDITABLE_FIELDS,
    // but the check is keyed on `session.userId === id` so it's
    // independent of role and won't go stale if the whitelist changes.
    const isDeactivating =
      input.isActive === false && existing.isActive === true;
    if (isDeactivating && session.userId === id) {
      return NextResponse.json(
        {
          error: 'forbidden',
          message: 'Cannot deactivate your own account',
        },
        { status: 403 },
      );
    }

    // Build the Prisma `data` payload. We deliberately splat keys
    // conditionally so missing fields stay missing (Prisma treats an
    // explicit `undefined` the same way, but explicit splats keep the
    // payload tiny and readable in logs).
    const data: Record<string, unknown> = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.email !== undefined) data.email = input.email;
    if (input.role !== undefined) data.role = input.role;
    if (input.phone !== undefined) data.phone = input.phone;
    if (input.designation !== undefined) data.designation = input.designation;
    if (input.joinedAt !== undefined) data.joinedAt = input.joinedAt;
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.password !== undefined) {
      data.passwordHash = await hash(input.password, BCRYPT_COST);
      // Signs the user's other devices out on their next session re-check.
      data.passwordChangedAt = new Date();
    }

    // Normalise moduleAccess + capture the previous value for activity
    // logging. The "effective role after this PATCH" is what determines
    // the normalisation: if the same call promotes EMPLOYEE → ADMIN, the
    // user is now an admin and admin rows must carry `[]`. Conversely,
    // demoting ADMIN → EMPLOYEE keeps whatever array the admin sent (or
    // leaves the column at its current `[]`, meaning "all modules" by
    // legacy semantics — admin must follow up to restrict access).
    const effectiveRole = input.role ?? existing.role;
    const previousModuleAccess = existing.moduleAccess;
    let nextModuleAccess: string[] | undefined;

    if (effectiveRole === 'ADMIN') {
      // Admin: force `[]`. If the row is already `[]` we still let
      // Prisma write the no-op — the diff check below handles
      // not-logging-a-changed-event in that case.
      nextModuleAccess = [];
      data.moduleAccess = [];
    } else if (input.moduleAccess !== undefined) {
      // Employee with an explicit value from the client. Trust the
      // schema (zod has already validated each entry is a known module
      // ID) and persist verbatim.
      nextModuleAccess = input.moduleAccess;
      data.moduleAccess = input.moduleAccess;
    }
    // else: employee, no moduleAccess in body → leave column as-is.

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: userPublicProjection,
    });

    // Best-effort audit log. Logging failures must not fail the write.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: isDeactivating
          ? ACTIVITY_ACTIONS.USER_DEACTIVATED
          : ACTIVITY_ACTIONS.USER_UPDATED,
        entityType: 'user',
        entityId: updated.id,
        metadata: {
          entityName: updated.name,
        },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/users/[id]] activity log failed', logErr);
    }

    // Separate audit row when the per-module whitelist changed. We emit
    // this IN ADDITION to user.updated (rather than instead of) so the
    // generic activity timeline still flags "an admin touched this row"
    // and the dedicated module-access audit gives the from/to diff. Skip
    // when the multiset is unchanged so no-op PATCHes don't spam the
    // log.
    if (
      nextModuleAccess !== undefined &&
      !moduleAccessEqual(previousModuleAccess, nextModuleAccess)
    ) {
      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.USER_MODULE_ACCESS_CHANGED,
          entityType: 'user',
          entityId: updated.id,
          metadata: {
            entityName: updated.name,
            from: previousModuleAccess,
            to: nextModuleAccess,
          },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/users/[id]] activity log failed', logErr);
      }
    }

    return NextResponse.json(updated as UserPublic);
  } catch (err) {
    return errorResponse(err);
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/users/[id]
// ---------------------------------------------------------------------------

/**
 * Soft delete. Admin only.
 *
 * Per SPEC.md §5.3, deleting an employee sets `isActive = false`
 * rather than removing the row — the `Lead.createdById` foreign key is
 * `RESTRICT`, so a hard delete on a user who ever created a lead would
 * fail at the DB layer and orphan historical activity log rows.
 *
 * Refuses to deactivate the calling admin's own account so a single
 * admin can't accidentally lock themselves out (SPEC.md §2.1).
 *
 * Activity log: `user.deactivated`. Calling DELETE on an already
 * inactive user is a no-op — we still return 204 so DELETE is
 * idempotent, but skip the activity log.
 */
export async function DELETE(
  _req: NextRequest,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const { id } = context.params;

    if (session.userId === id) {
      return NextResponse.json(
        {
          error: 'forbidden',
          message: 'Cannot deactivate your own account',
        },
        { status: 403 },
      );
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, isActive: true },
    });
    if (!existing) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    // Idempotent: if the user is already inactive, skip the write and
    // skip the audit log so we don't spam `user.deactivated` rows for
    // repeated calls.
    if (existing.isActive) {
      await prisma.user.update({
        where: { id },
        data: { isActive: false },
        select: { id: true },
      });

      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.USER_DEACTIVATED,
          entityType: 'user',
          entityId: existing.id,
          metadata: {
            entityName: existing.name,
          },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/users/[id]] activity log failed', logErr);
      }
    }

    // 204 No Content — body must be empty. NextResponse with `null`
    // body and status 204 is the canonical way to send this in Next.js.
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    return errorResponse(err);
  }
}
