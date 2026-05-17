/**
 * Integration tests for `GET`, `PATCH`, `DELETE` on `/api/campaigns/[id]`
 * and `GET /api/campaigns/[id]/leads` (task 44).
 *
 * Validates: Requirements 6.3, 6.4, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §7.2.3, §7.3, §7.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + the task brief:
 *
 *   Verb    Happy   401     403                            400 (zod)   404
 *   GET     ✓       ✓       —                              n/a          ✓
 *   PATCH   ✓       ✓       ✓ (employee not owner)         ✓ (empty)    ✓
 *   DELETE  ✓       ✓       ✓ (employee — admin only)      n/a          ✓
 *
 * Per the task brief:
 *   - GET by id: 200 with full row; 404 for non-existent.
 *   - PATCH: admin updates any field; employee can only update their own.
 *   - PATCH spend update: triggers `campaign.spent_updated` activity log
 *     with `delta` metadata.
 *   - PATCH metrics update: triggers `campaign.metrics_updated` with
 *     `fields` metadata.
 *   - DELETE: admin only; 403 for employee.
 *   - GET /leads: returns leads where `lead.utmCampaign === campaign.utmCampaign`.
 */

import { describe, expect, it } from 'vitest';
import {
  CampaignChannel,
  CampaignStatus,
  LeadSource,
  LeadStatus,
  Priority,
} from '@prisma/client';

import {
  GET as DETAIL_GET,
  PATCH,
  DELETE,
} from '@/app/api/campaigns/[id]/route';
import { GET as LEADS_GET } from '@/app/api/campaigns/[id]/leads/route';
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

interface SeedCampaignOverrides {
  name?: string;
  channel?: CampaignChannel;
  status?: CampaignStatus;
  startDate?: Date;
  endDate?: Date | null;
  budget?: number;
  spent?: number;
  impressions?: number;
  clicks?: number;
  signups?: number;
  conversions?: number;
  ownerId?: string;
  utmCampaign?: string | null;
}

/**
 * Insert a Campaign row directly. The required `ownerId` is supplied
 * explicitly because `Campaign.ownerId` is non-nullable.
 */
async function seedCampaign(
  ownerId: string,
  overrides: SeedCampaignOverrides = {},
): Promise<{
  id: string;
  utmCampaign: string | null;
  spent: number;
  impressions: number;
  clicks: number;
  signups: number;
  conversions: number;
}> {
  return prisma.campaign.create({
    data: {
      name: overrides.name ?? 'Detail Campaign',
      channel: overrides.channel ?? CampaignChannel.META_ADS,
      status: overrides.status ?? CampaignStatus.ACTIVE,
      startDate: overrides.startDate ?? new Date('2026-05-01T00:00:00Z'),
      ...(overrides.endDate !== undefined ? { endDate: overrides.endDate } : {}),
      budget: overrides.budget ?? 50_000,
      spent: overrides.spent ?? 1000,
      impressions: overrides.impressions ?? 100,
      clicks: overrides.clicks ?? 10,
      signups: overrides.signups ?? 2,
      conversions: overrides.conversions ?? 1,
      ownerId,
      ...(overrides.utmCampaign !== undefined
        ? { utmCampaign: overrides.utmCampaign }
        : {}),
    },
    select: {
      id: true,
      utmCampaign: true,
      spent: true,
      impressions: true,
      clicks: true,
      signups: true,
      conversions: true,
    },
  });
}

interface SeedLeadOverrides {
  name?: string;
  email?: string;
  utmCampaign?: string | null;
  status?: LeadStatus;
  createdAt?: Date;
}

async function seedLead(
  createdById: string,
  overrides: SeedLeadOverrides = {},
): Promise<{ id: string }> {
  return prisma.lead.create({
    data: {
      name: overrides.name ?? 'Lead',
      ...(overrides.email !== undefined ? { email: overrides.email } : {}),
      source: LeadSource.MANUAL,
      status: overrides.status ?? LeadStatus.NEW,
      priority: Priority.MEDIUM,
      ownerId: createdById,
      createdById,
      ...(overrides.utmCampaign !== undefined
        ? { utmCampaign: overrides.utmCampaign }
        : {}),
      ...(overrides.createdAt !== undefined
        ? { createdAt: overrides.createdAt }
        : {}),
    },
    select: { id: true },
  });
}

// ---------------------------------------------------------------------------
// GET /api/campaigns/[id]
// ---------------------------------------------------------------------------

describe('GET /api/campaigns/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id);
    await setSession(null);

    const res = await DETAIL_GET(
      buildJsonRequest('GET', `http://test/api/campaigns/${campaign.id}`),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DETAIL_GET(
      buildJsonRequest('GET', 'http://test/api/campaigns/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
    expect(await getJson(res)).toEqual({ error: 'not_found' });
  });

  it('returns the full campaign row with embedded owner', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const campaign = await seedCampaign(alice.id, {
      name: 'Owner Embed Test',
      channel: CampaignChannel.GOOGLE_ADS,
      utmCampaign: 'embed_test',
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DETAIL_GET(
      buildJsonRequest('GET', `http://test/api/campaigns/${campaign.id}`),
      buildRouteContext(campaign.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      id: string;
      name: string;
      channel: CampaignChannel;
      ownerId: string;
      utmCampaign: string | null;
      owner: { id: string; name: string; email: string } | null;
    }>(res);
    expect(body!.id).toBe(campaign.id);
    expect(body!.name).toBe('Owner Embed Test');
    expect(body!.channel).toBe(CampaignChannel.GOOGLE_ADS);
    expect(body!.ownerId).toBe(alice.id);
    expect(body!.utmCampaign).toBe('embed_test');
    expect(body!.owner).not.toBeNull();
    expect(body!.owner!.id).toBe(alice.id);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/campaigns/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/campaigns/[id] — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id);
    await setSession(null);

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        name: 'Hijacked',
      }),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE patches a campaign they do not own', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    // Owner = admin → employee has no claim.
    const campaign = await seedCampaign(admin.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        name: 'Hijacked',
      }),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.campaign.findUnique({
      where: { id: campaign.id },
    });
    expect(stored!.name).not.toBe('Hijacked');
  });

  it('admin can update any campaign regardless of ownership', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const campaign = await seedCampaign(employee.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        name: 'Admin-edited Name',
        status: 'PAUSED',
      }),
      buildRouteContext(campaign.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{ name: string; status: CampaignStatus }>(res);
    expect(body!.name).toBe('Admin-edited Name');
    expect(body!.status).toBe(CampaignStatus.PAUSED);
  });

  it('employee can update a campaign they own', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const campaign = await seedCampaign(employee.id, {
      name: 'My Campaign',
    });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        name: 'My Updated Campaign',
      }),
      buildRouteContext(campaign.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{ name: string }>(res);
    expect(body!.name).toBe('My Updated Campaign');
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', 'http://test/api/campaigns/missing-id', {
        name: 'Whatever',
      }),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/campaigns/[id] — activity logging', () => {
  it('writes a `campaign.spent_updated` row with `{delta, newSpent}` on a spend change', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, { spent: 1000 });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        spent: 2500,
      }),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'campaign.spent_updated',
        entityType: 'campaign',
        entityId: campaign.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({
      delta: 1500,
      newSpent: 2500,
    });
  });

  it('writes a `campaign.metrics_updated` row with `{fields}` listing changed metric columns', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, {
      impressions: 100,
      clicks: 10,
      signups: 2,
      conversions: 1,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        impressions: 500,
        clicks: 50,
      }),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(200);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'campaign.metrics_updated',
        entityType: 'campaign',
        entityId: campaign.id,
      },
    });
    expect(log).not.toBeNull();
    const meta = log!.metadata as { fields: string[] };
    expect(Array.isArray(meta.fields)).toBe(true);
    expect(meta.fields).toEqual(
      expect.arrayContaining(['impressions', 'clicks']),
    );
    expect(meta.fields).not.toContain('signups');
    expect(meta.fields).not.toContain('conversions');
  });

  it('writes a generic `campaign.updated` row when the change does not touch spend or metrics', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, { name: 'Original' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {
        name: 'Renamed',
      }),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(200);

    const updatedLog = await prisma.activityLog.findFirst({
      where: { action: 'campaign.updated', entityId: campaign.id },
    });
    expect(updatedLog).not.toBeNull();

    // No spend / metrics rows should have been written.
    const noisy = await prisma.activityLog.findMany({
      where: {
        entityId: campaign.id,
        action: { in: ['campaign.spent_updated', 'campaign.metrics_updated'] },
      },
    });
    expect(noisy).toHaveLength(0);
  });
});

describe('PATCH /api/campaigns/[id] — validation', () => {
  it('returns 400 on an empty PATCH body', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await PATCH(
      buildJsonRequest('PATCH', `http://test/api/campaigns/${campaign.id}`, {}),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/campaigns/[id]
// ---------------------------------------------------------------------------

describe('DELETE /api/campaigns/[id]', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id);
    await setSession(null);

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/campaigns/${campaign.id}`),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE tries to delete (admin-only)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const campaign = await seedCampaign(admin.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/campaigns/${campaign.id}`),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.campaign.findUnique({
      where: { id: campaign.id },
    });
    expect(stored).not.toBeNull();
  });

  it('returns 404 for a missing id', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', 'http://test/api/campaigns/missing-id'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('admin hard-deletes the campaign, returns 204 with no body, and writes `campaign.deleted`', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, { name: 'Doomed Campaign' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await DELETE(
      buildJsonRequest('DELETE', `http://test/api/campaigns/${campaign.id}`),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(204);
    expect(await getJson(res)).toBeNull();

    const stored = await prisma.campaign.findUnique({
      where: { id: campaign.id },
    });
    expect(stored).toBeNull();

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'campaign.deleted',
        entityType: 'campaign',
        entityId: campaign.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({ entityName: 'Doomed Campaign' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/campaigns/[id]/leads
// ---------------------------------------------------------------------------

describe('GET /api/campaigns/[id]/leads', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, {
      utmCampaign: 'auth_test',
    });
    await setSession(null);

    const res = await LEADS_GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/${campaign.id}/leads`,
      ),
      buildRouteContext(campaign.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 404 when the campaign id does not exist', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await LEADS_GET(
      buildJsonRequest('GET', 'http://test/api/campaigns/missing-id/leads'),
      buildRouteContext('missing-id'),
    );
    expect(res.status).toBe(404);
  });

  it('returns leads whose utmCampaign matches the campaign and excludes others', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const campaign = await seedCampaign(admin.id, {
      utmCampaign: 'diwali_2026',
    });

    // Two matching leads, one mismatched, one untagged.
    await seedLead(admin.id, {
      name: 'Match One',
      email: 'one@example.com',
      utmCampaign: 'diwali_2026',
    });
    await seedLead(admin.id, {
      name: 'Match Two',
      email: 'two@example.com',
      utmCampaign: 'diwali_2026',
    });
    await seedLead(admin.id, {
      name: 'Different Campaign',
      email: 'three@example.com',
      utmCampaign: 'holi_2026',
    });
    await seedLead(admin.id, {
      name: 'Untagged',
      email: 'four@example.com',
    });

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await LEADS_GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/${campaign.id}/leads`,
      ),
      buildRouteContext(campaign.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ name: string; utmCampaign: string | null }>;
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(body!.items).toHaveLength(2);
    expect(
      body!.items.every((l) => l.utmCampaign === 'diwali_2026'),
    ).toBe(true);
    expect(body!.items.map((l) => l.name).sort()).toEqual([
      'Match One',
      'Match Two',
    ]);
  });

  it('returns an empty page when the campaign has no utmCampaign tag', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    // Campaign without a UTM tag.
    const campaign = await seedCampaign(admin.id, { utmCampaign: null });
    // A lead with no UTM tag — would otherwise match `null = null`.
    await seedLead(admin.id, { name: 'Untagged Lead' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await LEADS_GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/${campaign.id}/leads`,
      ),
      buildRouteContext(campaign.id),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{ items: unknown[]; total: number }>(res);
    expect(body!.total).toBe(0);
    expect(body!.items).toHaveLength(0);
  });
});
