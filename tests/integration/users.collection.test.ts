/**
 * Integration tests for `GET /api/users` and `POST /api/users` (task 29).
 *
 * Validates: Requirements 4.2, 4.3, 4.5, 4.8, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §5.3, §16.2.
 *
 * Coverage matrix per SPEC §16.2:
 *
 *   Endpoint           Happy   401     403         400 (zod)
 *   GET  /api/users     ✓       ✓       ✓ (employee) —
 *   POST /api/users     ✓       ✓       ✓ (employee)  ✓
 *
 * Plus the per-endpoint specifics called out in tasks 25–26: bcrypt
 * hashing of the inserted password, `user.created` activity log entry,
 * 409 on duplicate emails, scoped list filters (role / isActive /
 * search), and pagination math.
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { compare } from 'bcryptjs';
import { describe, expect, it } from 'vitest';

import { GET, POST } from '@/app/api/users/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------

describe('GET /api/users — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await GET(buildJsonRequest('GET', 'http://test/api/users'));
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });

  it('returns 403 when an EMPLOYEE calls the admin-only list endpoint', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: employee.role });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/users'));

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body?.error).toBe('forbidden');
  });
});

describe('GET /api/users — happy path', () => {
  it('returns the paginated list with total/page/pageSize when called by ADMIN', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await createTestUser({ role: 'EMPLOYEE', name: 'Bob' });
    await createTestUser({ role: 'EMPLOYEE', name: 'Carol' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/users'));

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ name: string; passwordHash?: string }>;
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.total).toBe(3);
    expect(body!.page).toBe(1);
    expect(body!.pageSize).toBe(50);
    expect(body!.items).toHaveLength(3);
    // The public projection MUST NOT leak passwordHash (SPEC §2.2 / §12.2).
    for (const item of body!.items) {
      expect(item.passwordHash).toBeUndefined();
    }
  });

  it('honours the role filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await createTestUser({ role: 'EMPLOYEE' });
    await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/users?role=EMPLOYEE'),
    );
    const body = await getJson<{ items: Array<{ role: string }>; total: number }>(
      res,
    );
    expect(body!.total).toBe(2);
    expect(body!.items.every((u) => u.role === 'EMPLOYEE')).toBe(true);
  });

  it('honours the isActive filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await createTestUser({ role: 'EMPLOYEE', isActive: false });
    await createTestUser({ role: 'EMPLOYEE', isActive: true });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/users?isActive=false'),
    );
    const body = await getJson<{
      items: Array<{ isActive: boolean }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(1);
    expect(body!.items[0]!.isActive).toBe(false);
  });

  it('honours the case-insensitive search filter on name and email', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      name: 'Admin Person',
    });
    await createTestUser({ role: 'EMPLOYEE', name: 'Alice Wonderland' });
    await createTestUser({ role: 'EMPLOYEE', name: 'Bob Builder' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/users?search=alice'),
    );
    const body = await getJson<{ items: Array<{ name: string }>; total: number }>(
      res,
    );
    expect(body!.total).toBe(1);
    expect(body!.items[0]!.name).toBe('Alice Wonderland');
  });

  it('respects pagination via page + pageSize', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    // Plus the admin → 6 users total.
    for (let i = 0; i < 5; i += 1) {
      await createTestUser({ role: 'EMPLOYEE' });
    }
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/users?page=2&pageSize=2',
      ),
    );
    const body = await getJson<{
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body!.total).toBe(6);
    expect(body!.page).toBe(2);
    expect(body!.pageSize).toBe(2);
    expect(body!.items).toHaveLength(2);
  });

  it('returns 400 when query params are invalid (page=0)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/users?page=0'),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body?.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/users
// ---------------------------------------------------------------------------

describe('POST /api/users — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'new@example.com',
        password: 'SuperSecret9!',
        name: 'New Person',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE attempts to create a user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'newhire@example.com',
        password: 'SuperSecret9!',
        name: 'New Hire',
      }),
    );

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');

    // Defensive: confirm we did not create the row regardless.
    const count = await prisma.user.count({
      where: { email: 'newhire@example.com' },
    });
    expect(count).toBe(0);
  });
});

describe('POST /api/users — happy path', () => {
  it('hashes the password, persists the user, and returns 201 without leaking passwordHash', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const plaintextPassword = 'CorrectHorseBattery!9';
    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'fresh@example.com',
        password: plaintextPassword,
        name: 'Fresh Hire',
        role: 'EMPLOYEE',
        designation: 'Engineer',
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      email: string;
      name: string;
      role: string;
      passwordHash?: string;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.email).toBe('fresh@example.com');
    expect(body!.name).toBe('Fresh Hire');
    expect(body!.role).toBe('EMPLOYEE');
    // `userPublicProjection` must hide the hash (SPEC §2.2).
    expect(body!.passwordHash).toBeUndefined();

    // The DB row exists and the password was bcrypt-hashed (not stored
    // in plaintext). bcrypt-hashed strings start with `$2`.
    const stored = await prisma.user.findUnique({
      where: { email: 'fresh@example.com' },
    });
    expect(stored).not.toBeNull();
    expect(stored!.passwordHash).not.toBe(plaintextPassword);
    expect(stored!.passwordHash.startsWith('$2')).toBe(true);
    expect(await compare(plaintextPassword, stored!.passwordHash)).toBe(true);
  });

  it('writes a `user.created` activity log row tied to the calling admin', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'audited@example.com',
        password: 'AuditMe123!',
        name: 'Audited User',
      }),
    );
    expect(res.status).toBe(201);

    const body = await getJson<{ id: string }>(res);
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'user.created',
        entityType: 'user',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
  });

  it('persists the moduleAccess whitelist for EMPLOYEE create', async () => {
    // FEATURE-A / v0.1.3: admin can stamp a per-module whitelist on an
    // EMPLOYEE row at creation. We send a subset and verify it survives
    // the round-trip both on the wire and in the DB.
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'whitelisted@example.com',
        password: 'WhitelistMe9!',
        name: 'Whitelisted Hire',
        role: 'EMPLOYEE',
        moduleAccess: ['leads', 'marketing'],
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ id: string; moduleAccess: string[] }>(res);
    expect(body!.moduleAccess).toEqual(
      expect.arrayContaining(['leads', 'marketing']),
    );
    expect(body!.moduleAccess).toHaveLength(2);

    const stored = await prisma.user.findUnique({
      where: { email: 'whitelisted@example.com' },
      select: { moduleAccess: true },
    });
    expect(stored!.moduleAccess.sort()).toEqual(['leads', 'marketing']);
  });

  it('normalises moduleAccess to [] when creating an ADMIN user even if non-empty input is provided', async () => {
    // Admins always see every module, so the column for an admin row
    // should be `[]` regardless of what the form sent — the route
    // handler normalises before persist. This keeps the DB state clean
    // (no dead `moduleAccess` rows on admins) and enforces the "ADMIN
    // ignores this column" invariant at the write site.
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'newadmin@example.com',
        password: 'AdminPass9!',
        name: 'New Admin',
        role: 'ADMIN',
        moduleAccess: ['leads', 'marketing'],
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ moduleAccess: string[] }>(res);
    expect(body!.moduleAccess).toEqual([]);

    const stored = await prisma.user.findUnique({
      where: { email: 'newadmin@example.com' },
      select: { moduleAccess: true },
    });
    expect(stored!.moduleAccess).toEqual([]);
  });

  it('lower-cases and trims the email before persisting (zod transform)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: '  Mixed@Example.COM  ',
        password: 'SuperSecret9!',
        name: 'Case Sensitive',
      }),
    );
    expect(res.status).toBe(201);

    const stored = await prisma.user.findUnique({
      where: { email: 'mixed@example.com' },
    });
    expect(stored).not.toBeNull();
  });
});

describe('POST /api/users — validation', () => {
  it('returns 400 when the body is missing required fields', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        // Missing email, password, name.
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    // No row should be created on validation failure.
    expect(await prisma.user.count()).toBe(1); // only the admin
  });

  it('returns 400 when the password is too short', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'short@example.com',
        password: 'short', // 5 chars, below the 8-char floor
        name: 'Short Pass',
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });

  it('returns 400 when the body is not JSON', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const req = new Request('http://test/api/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json-at-all',
    }) as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/users — conflicts', () => {
  it('returns 409 with target=email on duplicate email insertion', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Seed a row to collide with.
    await prisma.user.create({
      data: {
        email: 'taken@example.com',
        passwordHash: '$2a$04$abcdefghijklmnopqrstuv',
        name: 'Existing',
        role: 'EMPLOYEE',
      },
    });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/users', {
        email: 'taken@example.com',
        password: 'TryToSteal9!',
        name: 'Imposter',
      }),
    );

    expect(res.status).toBe(409);
    const body = await getJson<{ error: string; target?: string[] }>(res);
    expect(body!.error).toBe('conflict');
    expect(body!.target).toContain('email');
  });
});
