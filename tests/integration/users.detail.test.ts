/**
 * Integration tests for `GET`, `PATCH`, and `DELETE` on `/api/users/[id]`
 * (task 29).
 *
 * Validates: Requirements 4.5, 4.6, 4.8, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §5.3, §16.2.
 *
 * Coverage matrix per SPEC §16.2:
 *
 *   Verb    Happy   401     403                         400 (zod)   404
 *   GET     ✓       ✓       ✓ (employee → other)        n/a         ✓
 *   PATCH   ✓       ✓       ✓ (employee → other,         ✓           ✓
 *                                  field not allowed)
 *   DELETE  ✓       ✓       ✓ (employee, self-delete)   n/a         ✓
 *
 * Plus the per-endpoint specifics:
 *   - PATCH password is bcrypt-hashed (not stored verbatim).
 *   - PATCH email collision returns 409 with `target=email`.
 *   - PATCH that flips `isActive: true → false` writes `user.deactivated`.
 *   - PATCH otherwise writes `user.updated`.
 *   - DELETE is idempotent (already-inactive returns 204 with no extra log).
 *   - DELETE/PATCH both refuse to deactivate the calling admin's own row.
 */

import { compare } from 'bcryptjs';
import { describe, expect, it } from 'vitest';

import {
  GET,
  PATCH,
  DELETE,
} from '@/app/api/users/[id]/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// GET /api/users/[id]
// ---------------------------------------------------------------------------

describe('GET /api/users/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user } = await createTestUser();
    await setSession(null);

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${user.id}`),
      buildRouteContext(user.id),
    );
    expect(res.status).toBe(401);
  });

  it('admin can fetch any user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${target.id}`),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ id: string; passwordHash?: string }>(res);
    expect(body!.id).toBe(target.id);
    expect(body!.passwordHash).toBeUndefined();
  });

  it('employee can fetch their own row', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${employee.id}`),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);
  });

  it("employee gets 403 when fetching another user's row", async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/users/${other.id}`),
      buildRouteContext(other.id),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/users/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
    expect(await getJson(res)).toEqual({ error: 'not_found' });
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/users/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/users/[id] — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user } = await createTestUser();
    await setSession(null);

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${user.id}`, {
        name: 'New Name',
      }),
      buildRouteContext(user.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an employee tries to patch another user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        name: 'Hijack',
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(403);
  });

  it('returns 403 when an employee patches their own row with a forbidden field (role)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${employee.id}`, {
        role: 'ADMIN',
      }),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(403);

    // Sanity: the role on disk did not change.
    const stored = await prisma.user.findUnique({
      where: { id: employee.id },
      select: { role: true },
    });
    expect(stored!.role).toBe('EMPLOYEE');
  });

  it('returns 403 when an employee tries to flip isActive on themselves', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${employee.id}`, {
        isActive: false,
      }),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/users/[id] — happy path', () => {
  it('admin can update any field including role and isActive', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        name: 'Updated Name',
        role: 'ADMIN',
        designation: 'Lead Engineer',
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ name: string; role: string }>(res);
    expect(body!.name).toBe('Updated Name');
    expect(body!.role).toBe('ADMIN');

    // user.updated activity log entry
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'user.updated',
        entityType: 'user',
        entityId: target.id,
      },
    });
    expect(log).not.toBeNull();
  });

  it('employee can update their own allowed fields', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${employee.id}`, {
        name: 'My New Name',
        designation: 'Senior Engineer',
      }),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ name: string; designation: string }>(res);
    expect(body!.name).toBe('My New Name');
    expect(body!.designation).toBe('Senior Engineer');
  });

  it('hashes a password supplied via PATCH instead of storing it verbatim', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const newPassword = 'BrandNewPass!9';
    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${employee.id}`, {
        password: newPassword,
      }),
      buildRouteContext(employee.id),
    );
    expect(res.status).toBe(200);

    const stored = await prisma.user.findUnique({
      where: { id: employee.id },
    });
    expect(stored!.passwordHash).not.toBe(newPassword);
    expect(stored!.passwordHash.startsWith('$2')).toBe(true);
    expect(await compare(newPassword, stored!.passwordHash)).toBe(true);
  });

  it('writes user.module_access_changed when admin updates the moduleAccess whitelist', async () => {
    // FEATURE-A / v0.1.3: when the per-module whitelist changes, the
    // PATCH emits a separate `user.module_access_changed` row IN
    // ADDITION to `user.updated`. The metadata carries `from`/`to`
    // arrays so the audit feed can render the diff.
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        moduleAccess: ['leads', 'marketing'],
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ moduleAccess: string[] }>(res);
    expect(body!.moduleAccess.sort()).toEqual(['leads', 'marketing']);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'user.module_access_changed',
        entityType: 'user',
        entityId: target.id,
      },
    });
    expect(log).not.toBeNull();
    // Metadata should carry the from/to diff. Stored as Json so the
    // type is `unknown` until narrowed.
    const meta = log!.metadata as { from?: unknown; to?: unknown };
    expect(meta.from).toEqual([]);
    expect(Array.isArray(meta.to)).toBe(true);
    expect((meta.to as string[]).sort()).toEqual(['leads', 'marketing']);
  });

  it('normalises moduleAccess to [] when admin promotes EMPLOYEE → ADMIN with a non-empty whitelist', async () => {
    // Promoting to ADMIN must collapse moduleAccess back to `[]` even
    // if the same PATCH body included a non-empty list — admins ignore
    // the column entirely and we want the DB state to stay clean.
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    // Seed an existing whitelist so the test exercises the "promote
    // while wiping" path rather than the "create-from-empty" path.
    await prisma.user.update({
      where: { id: target.id },
      data: { moduleAccess: ['leads'] },
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        role: 'ADMIN',
        moduleAccess: ['marketing', 'social'],
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ role: string; moduleAccess: string[] }>(res);
    expect(body!.role).toBe('ADMIN');
    expect(body!.moduleAccess).toEqual([]);

    const stored = await prisma.user.findUnique({
      where: { id: target.id },
      select: { role: true, moduleAccess: true },
    });
    expect(stored!.role).toBe('ADMIN');
    expect(stored!.moduleAccess).toEqual([]);
  });

  it('writes user.deactivated when admin flips isActive from true to false', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({
      role: 'EMPLOYEE',
      isActive: true,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        isActive: false,
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'user.deactivated',
        entityType: 'user',
        entityId: target.id,
      },
    });
    expect(log).not.toBeNull();
  });
});

describe('PATCH /api/users/[id] — validation and conflicts', () => {
  it('returns 400 on an empty PATCH body', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {}),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(400);
  });

  it('returns 400 on invalid email format', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${target.id}`, {
        email: 'not-an-email',
      }),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });

  it('returns 409 with target=email when patching to a colliding email', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: a } = await createTestUser({
      role: 'EMPLOYEE',
      email: 'a@example.com',
    });
    await createTestUser({ role: 'EMPLOYEE', email: 'b@example.com' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${a.id}`, {
        email: 'b@example.com',
      }),
      buildRouteContext(a.id),
    );
    expect(res.status).toBe(409);
    const body = await getJson<{ error: string; target?: string[] }>(res);
    expect(body!.error).toBe('conflict');
    expect(body!.target).toContain('email');
  });

  it('returns 404 when patching a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/users/missing-id', {
        name: 'Phantom',
      }),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('refuses to deactivate the calling admin', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/users/${admin.id}`, {
        isActive: false,
      }),
      buildRouteContext(admin.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(stored!.isActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/users/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/users/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user } = await createTestUser();
    await setSession(null);

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/users/${user.id}`),
      buildRouteContext(user.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an employee tries to delete', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: target } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/users/${target.id}`),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.user.findUnique({ where: { id: target.id } });
    expect(stored!.isActive).toBe(true);
  });

  it('admin soft-deletes a user (isActive=false) and writes user.deactivated', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({
      role: 'EMPLOYEE',
      isActive: true,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/users/${target.id}`),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(204);
    expect(await getJson(res)).toBeNull();

    const stored = await prisma.user.findUnique({ where: { id: target.id } });
    expect(stored!.isActive).toBe(false);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'user.deactivated',
        entityType: 'user',
        entityId: target.id,
      },
    });
    expect(log).not.toBeNull();
  });

  it('refuses to delete the calling admin (cannot deactivate self)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/users/${admin.id}`),
      buildRouteContext(admin.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.user.findUnique({ where: { id: admin.id } });
    expect(stored!.isActive).toBe(true);
  });

  it('returns 404 on a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', 'http://test/api/users/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('is idempotent: a second DELETE on an already-inactive row still returns 204', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: target } = await createTestUser({
      role: 'EMPLOYEE',
      isActive: false,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/users/${target.id}`),
      buildRouteContext(target.id),
    );
    expect(res.status).toBe(204);

    // No new user.deactivated row written for the no-op.
    const logs = await prisma.activityLog.findMany({
      where: {
        action: 'user.deactivated',
        entityId: target.id,
      },
    });
    expect(logs).toHaveLength(0);
  });
});
