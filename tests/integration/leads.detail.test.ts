/**
 * Integration tests for `GET`, `PATCH`, and `DELETE` on `/api/leads/[id]`
 * (task 36).
 *
 * Validates: Requirements 5.4, 5.6, 5.12, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §6.3, §6.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2:
 *
 *   Verb    Happy   401     403                            400 (zod)   404
 *   GET     ✓       ✓       —                              n/a          ✓
 *   PATCH   ✓       ✓       ✓ (employee not owner/creator)  ✓ (empty)   —
 *   DELETE  ✓       ✓       ✓ (employee)                    n/a          ✓
 *
 * Plus the per-endpoint specifics from the task brief:
 *   - PATCH writes LEAD_STATUS_CHANGED with `{from, to}` metadata.
 *   - PATCH that flips status → CONVERTED writes LEAD_CONVERTED AND
 *     stamps `convertedAt = now`.
 *   - A second PATCH that's still CONVERTED does NOT reset `convertedAt`.
 *   - PATCH that changes ownerId (admin) writes LEAD_ASSIGNED.
 *   - PATCH with empty body returns 400.
 *   - DELETE returns 204 + the lead is gone, LEAD_DELETED log written.
 */

import { describe, expect, it } from 'vitest';
import { LeadStatus, Priority } from '@prisma/client';

import {
  GET,
  PATCH,
  DELETE,
} from '@/app/api/leads/[id]/route';
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

interface SeedLeadOverrides {
  name?: string;
  status?: LeadStatus;
  priority?: Priority;
  ownerId?: string | null;
  convertedAt?: Date | null;
  email?: string;
  phone?: string;
}

/**
 * Insert a Lead row directly via Prisma. The required `createdById`
 * passed in by the test is also the default `ownerId` unless the
 * caller explicitly overrides it (matching the route's own default).
 */
async function seedLead(
  createdById: string,
  overrides: SeedLeadOverrides = {},
): Promise<{ id: string }> {
  const lead = await prisma.lead.create({
    data: {
      name: overrides.name ?? 'Detail Lead',
      ...(overrides.email !== undefined ? { email: overrides.email } : {}),
      ...(overrides.phone !== undefined ? { phone: overrides.phone } : {}),
      status: overrides.status ?? LeadStatus.NEW,
      priority: overrides.priority ?? Priority.MEDIUM,
      ownerId:
        overrides.ownerId === undefined ? createdById : overrides.ownerId,
      createdById,
      ...(overrides.convertedAt !== undefined
        ? { convertedAt: overrides.convertedAt }
        : {}),
    },
    select: { id: true },
  });
  return lead;
}

// ---------------------------------------------------------------------------
// GET /api/leads/[id]
// ---------------------------------------------------------------------------

describe('GET /api/leads/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession(null);

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads/${lead.id}`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/leads/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
    expect(await getJson(res)).toEqual({ error: 'not_found' });
  });

  it('returns the lead with embedded owner', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const lead = await seedLead(admin.id, {
      name: 'Owner Embed Test',
      ownerId: alice.id,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', `http://test/api/leads/${lead.id}`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{
      id: string;
      ownerId: string | null;
      owner: { id: string; name: string; email: string } | null;
    }>(res);
    expect(body!.id).toBe(lead.id);
    expect(body!.ownerId).toBe(alice.id);
    expect(body!.owner).not.toBeNull();
    expect(body!.owner!.id).toBe(alice.id);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/leads/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/leads/[id] — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession(null);

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        name: 'Hijack',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE patches a lead they neither own nor created', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    // Owner = admin, createdBy = admin → the employee has no claim.
    const lead = await seedLead(admin.id, { ownerId: admin.id });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        name: 'Hijacked',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(stored!.name).not.toBe('Hijacked');
  });

  it('admin can update any lead regardless of ownership', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const lead = await seedLead(employee.id, { ownerId: employee.id });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        name: 'Admin-edited Name',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ name: string }>(res);
    expect(body!.name).toBe('Admin-edited Name');
  });
});

describe('PATCH /api/leads/[id] — activity logging', () => {
  it('writes a LEAD_STATUS_CHANGED row with {from, to} metadata on a status change', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id, { status: LeadStatus.NEW });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        status: 'CONTACTED',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'lead.status_changed',
        entityType: 'lead',
        entityId: lead.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({ from: 'NEW', to: 'CONTACTED' });
  });

  it('writes BOTH LEAD_STATUS_CHANGED and LEAD_CONVERTED on transition to CONVERTED, and stamps convertedAt', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id, { status: LeadStatus.INTERESTED });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        status: 'CONVERTED',
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ status: string; convertedAt: string | null }>(
      res,
    );
    expect(body!.status).toBe('CONVERTED');
    expect(body!.convertedAt).not.toBeNull();

    const stored = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(stored!.convertedAt).not.toBeNull();

    const statusLog = await prisma.activityLog.findFirst({
      where: { action: 'lead.status_changed', entityId: lead.id },
    });
    expect(statusLog).not.toBeNull();
    expect(statusLog!.metadata).toMatchObject({
      from: 'INTERESTED',
      to: 'CONVERTED',
    });

    const convertedLog = await prisma.activityLog.findFirst({
      where: { action: 'lead.converted', entityId: lead.id },
    });
    expect(convertedLog).not.toBeNull();
  });

  it('does not reset convertedAt on a second PATCH that keeps status=CONVERTED', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // First flip to CONVERTED via the route so convertedAt is set
    // by the handler (the only authorized way).
    const lead = await seedLead(admin.id, { status: LeadStatus.INTERESTED });
    const first = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        status: 'CONVERTED',
      }),
      buildRouteContext(lead.id),
    );
    expect(first.status).toBe(200);
    const firstBody = await getJson<{ convertedAt: string }>(first);
    expect(firstBody!.convertedAt).not.toBeNull();
    const firstConvertedAt = firstBody!.convertedAt;

    // Wait a few ms so any spurious re-stamp would produce a
    // measurable delta.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const second = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        status: 'CONVERTED',
        notes: 'Still converted, just touching the row.',
      }),
      buildRouteContext(lead.id),
    );
    expect(second.status).toBe(200);
    const secondBody = await getJson<{ convertedAt: string }>(second);
    expect(secondBody!.convertedAt).toBe(firstConvertedAt);

    // No second LEAD_CONVERTED log written.
    const convertedLogs = await prisma.activityLog.findMany({
      where: { action: 'lead.converted', entityId: lead.id },
    });
    expect(convertedLogs).toHaveLength(1);
  });

  it('writes a LEAD_ASSIGNED row when admin reassigns ownership', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const lead = await seedLead(admin.id, { ownerId: admin.id });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        ownerId: alice.id,
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: { action: 'lead.assigned', entityId: lead.id },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({
      fromOwnerId: admin.id,
      toOwnerId: alice.id,
    });
  });

  it('returns 403 when an employee tries to reassign a lead they own to another user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    // Employee owns the lead, so the write itself is permitted.
    const lead = await seedLead(employee.id, { ownerId: employee.id });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {
        ownerId: other.id,
      }),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(stored!.ownerId).toBe(employee.id);
  });
});

describe('PATCH /api/leads/[id] — validation', () => {
  it('returns 400 on an empty PATCH body', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/leads/${lead.id}`, {}),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/leads/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/leads/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id);
    await setSession(null);

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/leads/${lead.id}`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE tries to delete (admin-only)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const lead = await seedLead(admin.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/leads/${lead.id}`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(403);

    // Lead still exists.
    const stored = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(stored).not.toBeNull();
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', 'http://test/api/leads/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('admin hard-deletes the lead, returns 204 with no body, and writes LEAD_DELETED', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const lead = await seedLead(admin.id, { name: 'Doomed Lead' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/leads/${lead.id}`),
      buildRouteContext(lead.id),
    );
    expect(res.status).toBe(204);
    expect(await getJson(res)).toBeNull();

    const stored = await prisma.lead.findUnique({ where: { id: lead.id } });
    expect(stored).toBeNull();

    // Activity log row survives (FK is SET NULL on Lead delete) and
    // captures the lead's name in metadata.
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'lead.deleted',
        entityType: 'lead',
        entityId: lead.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({ entityName: 'Doomed Lead' });
  });
});
