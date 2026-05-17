/**
 * Integration tests for `GET` and `POST` on `/api/leads/[id]/notes`
 * (task 36).
 *
 * Validates: Requirements 5.6, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §6.3, §6.2 #6, §16.2.
 *
 * Coverage matrix per SPEC §16.2:
 *
 *   Verb    Happy   401     404 (missing lead)   400 (zod)
 *   GET     ✓       ✓       ✓                    n/a
 *   POST    ✓       ✓       ✓                    ✓ (missing body)
 *
 * Plus the per-endpoint specifics from the task brief:
 *   - GET returns notes in newest-first order with the author embedded.
 *   - POST writes a `lead.note_added` activity log row tied to the lead.
 *   - The author of the note is `session.userId` regardless of any
 *     `authorId` field a misbehaving client tries to send.
 */

import { describe, expect, it } from 'vitest';

import { GET, POST } from '@/app/api/leads/[id]/notes/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Helpers — local to this file
// ---------------------------------------------------------------------------

/**
 * Insert a Lead row directly via Prisma. The required `createdById`
 * passed in by the test is also the default `ownerId`. Notes don't
 * care about ownership (any authenticated user can read/write), so
 * tests don't need to override either field.
 */
async function seedLead(createdById: string, name = 'Notes Lead') {
  return prisma.lead.create({
    data: {
      name,
      ownerId: createdById,
      createdById,
    },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// GET /api/leads/[id]/notes
// ---------------------------------------------------------------------------

describe('GET /api/leads/[id]/notes', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession(null);

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads/${lead.id}/notes`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the lead does not exist', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads/missing-id/notes'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
    expect(await getJson(res)).toEqual({ error: 'not_found' });
  });

  it('returns notes in newest-first order with the author embedded', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      name: 'Note Author',
    });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Seed three notes with explicit createdAt timestamps.
    await prisma.note.create({
      data: {
        body: 'first note',
        authorId: admin.id,
        entityType: 'lead',
        entityId: lead.id,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    });
    await prisma.note.create({
      data: {
        body: 'second note',
        authorId: admin.id,
        entityType: 'lead',
        entityId: lead.id,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
    });
    await prisma.note.create({
      data: {
        body: 'third note',
        authorId: admin.id,
        entityType: 'lead',
        entityId: lead.id,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
    });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads/${lead.id}/notes`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      items: Array<{
        body: string;
        author: { id: string; name: string };
      }>;
    }>(res);
    expect(body!.items).toHaveLength(3);
    // Newest-first order
    expect(body!.items.map((n) => n.body)).toEqual([
      'third note',
      'second note',
      'first note',
    ]);
    // Author embedded on every row
    for (const item of body!.items) {
      expect(item.author.id).toBe(admin.id);
      expect(item.author.name).toBe('Note Author');
    }
  });

  it('returns an empty list when the lead exists but has no notes', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads/${lead.id}/notes`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ items: unknown[] }>(res);
    expect(body!.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/leads/[id]/notes
// ---------------------------------------------------------------------------

describe('POST /api/leads/[id]/notes', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession(null);

    const res = await POST(
      buildJsonRequest('POST', `http://test/api/leads/${lead.id}/notes`, {
        body: 'Anonymous note',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(401);
    expect(await prisma.note.count()).toBe(0);
  });

  it('returns 404 when the lead does not exist', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/leads/missing-id/notes', {
        body: 'Note for ghost lead',
      }),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
    expect(await prisma.note.count()).toBe(0);
  });

  it('returns 400 when the body field is missing', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', `http://test/api/leads/${lead.id}/notes`, {}),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.note.count()).toBe(0);
  });

  it('returns 201 with the new note, author embedded, and persists the row', async () => {
    const { user: admin } = await createTestUser({
      role: 'ADMIN',
      name: 'Author Admin',
    });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', `http://test/api/leads/${lead.id}/notes`, {
        body: 'First contact made — discovery call scheduled.',
      }),
      buildRouteContext(lead.id),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      body: string;
      authorId: string;
      entityType: string;
      entityId: string;
      author: { id: string; name: string };
    }>(res);
    expect(body!.body).toBe('First contact made — discovery call scheduled.');
    expect(body!.authorId).toBe(admin.id);
    expect(body!.entityType).toBe('lead');
    expect(body!.entityId).toBe(lead.id);
    expect(body!.author.id).toBe(admin.id);
    expect(body!.author.name).toBe('Author Admin');

    const stored = await prisma.note.findUnique({ where: { id: body!.id } });
    expect(stored).not.toBeNull();
    expect(stored!.authorId).toBe(admin.id);
  });

  it('writes a `lead.note_added` activity log row tied to the lead', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id, 'Audited Notes Lead');
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', `http://test/api/leads/${lead.id}/notes`, {
        body: 'Auditable note.',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ id: string }>(res);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'lead.note_added',
        entityType: 'lead',
        entityId: lead.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.leadId).toBe(lead.id);
    expect(log!.metadata).toMatchObject({
      noteId: body!.id,
      entityName: 'Audited Notes Lead',
    });
  });

  it('always uses session.userId for authorId — ignores any client-supplied authorId', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: someone } = await createTestUser({ role: 'EMPLOYEE' });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', `http://test/api/leads/${lead.id}/notes`, {
        body: 'Trying to forge an author',
        // Schema-stripped — but worth pinning down.
        authorId: someone.id,
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(201);
    const body = await getJson<{ authorId: string }>(res);
    expect(body!.authorId).toBe(admin.id);
  });
});
