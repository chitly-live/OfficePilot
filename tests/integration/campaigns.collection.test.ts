/**
 * Integration tests for `GET /api/campaigns` and `POST /api/campaigns`
 * (task 44).
 *
 * Validates: Requirements 6.3, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §7.3, §7.4, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + the task brief:
 *
 *   Endpoint               Happy   401     403         400 (zod)
 *   GET  /api/campaigns     ✓       ✓       —            ✓ (bad page)
 *   POST /api/campaigns     ✓       ✓       ✓ (cross-   ✓ (missing
 *                                              assign)     fields)
 *
 * Per the task brief:
 *   - GET: lists campaigns. Per SPEC §2.1, employees may *read* every
 *     campaign — the route comment makes this explicit ("campaigns are
 *     a globally readable shared workspace"). We assert that here so a
 *     future RBAC change has to update the test deliberately.
 *   - GET filters: status (multi), channel (multi), search.
 *   - GET pagination: page + pageSize round-tripped.
 *   - POST: admin creates a campaign; logs `campaign.created`.
 *   - POST: employee creates a campaign owned by themselves.
 *   - POST: 401 without session.
 *   - POST: 400 on missing required fields.
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { describe, expect, it } from 'vitest';
import { CampaignChannel, CampaignStatus } from '@prisma/client';

import { GET, POST } from '@/app/api/campaigns/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
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
  ownerId?: string;
  utmCampaign?: string | null;
  createdAt?: Date;
}

/**
 * Insert a Campaign row directly via Prisma, bypassing the route
 * handler. Used by GET tests where the *list* shape is what matters;
 * the create flow itself is exercised by the POST tests below.
 *
 * Required FK: `ownerId` — Campaign has no application default. Tests
 * pass the seeded admin's id (or a freshly-created employee's id) as
 * appropriate.
 */
async function seedCampaign(
  ownerId: string,
  overrides: SeedCampaignOverrides = {},
): Promise<{ id: string; utmCampaign: string | null }> {
  const campaign = await prisma.campaign.create({
    data: {
      name: overrides.name ?? 'Seed Campaign',
      channel: overrides.channel ?? CampaignChannel.META_ADS,
      status: overrides.status ?? CampaignStatus.DRAFT,
      startDate: overrides.startDate ?? new Date('2026-05-01T00:00:00Z'),
      ...(overrides.endDate !== undefined ? { endDate: overrides.endDate } : {}),
      budget: overrides.budget ?? 10_000,
      spent: overrides.spent ?? 0,
      ownerId,
      ...(overrides.utmCampaign !== undefined
        ? { utmCampaign: overrides.utmCampaign }
        : {}),
      ...(overrides.createdAt !== undefined
        ? { createdAt: overrides.createdAt }
        : {}),
    },
    select: { id: true, utmCampaign: true },
  });
  return campaign;
}

// ---------------------------------------------------------------------------
// GET /api/campaigns
// ---------------------------------------------------------------------------

describe('GET /api/campaigns — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await GET(buildJsonRequest('GET', 'http://test/api/campaigns'));
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

describe('GET /api/campaigns — happy path', () => {
  it('returns the paginated list with total/page/pageSize when called by ADMIN', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedCampaign(admin.id, { name: 'Diwali Push' });
    await seedCampaign(admin.id, { name: 'New Year Blitz' });
    await seedCampaign(admin.id, { name: 'Spring Refresh' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/campaigns'));

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ id: string; name: string; owner: { id: string } | null }>;
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.total).toBe(3);
    expect(body!.page).toBe(1);
    expect(body!.pageSize).toBe(50);
    expect(body!.items).toHaveLength(3);
    // Each item embeds owner via campaignPublicProjection.
    for (const item of body!.items) {
      expect(item.owner).not.toBeNull();
    }
  });

  it('an EMPLOYEE sees every campaign (campaigns are a shared workspace per SPEC §2.1)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    // Two campaigns owned by the admin — the employee should still see them.
    await seedCampaign(admin.id);
    await seedCampaign(admin.id);
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await GET(buildJsonRequest('GET', 'http://test/api/campaigns'));

    expect(res.status).toBe(200);
    const body = await getJson<{ total: number }>(res);
    expect(body!.total).toBe(2);
  });
});

describe('GET /api/campaigns — filters', () => {
  it('honours multi-value status filter (comma separated)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedCampaign(admin.id, { status: CampaignStatus.DRAFT });
    await seedCampaign(admin.id, { status: CampaignStatus.ACTIVE });
    await seedCampaign(admin.id, { status: CampaignStatus.ENDED });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/campaigns?status=DRAFT,ACTIVE',
      ),
    );

    const body = await getJson<{
      items: Array<{ status: CampaignStatus }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(
      body!.items.every((c) => c.status !== CampaignStatus.ENDED),
    ).toBe(true);
  });

  it('honours multi-value channel filter', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedCampaign(admin.id, { channel: CampaignChannel.META_ADS });
    await seedCampaign(admin.id, { channel: CampaignChannel.GOOGLE_ADS });
    await seedCampaign(admin.id, { channel: CampaignChannel.YOUTUBE });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/campaigns?channel=META_ADS,GOOGLE_ADS',
      ),
    );

    const body = await getJson<{
      items: Array<{ channel: CampaignChannel }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(2);
    expect(
      body!.items.every((c) => c.channel !== CampaignChannel.YOUTUBE),
    ).toBe(true);
  });

  it('honours the case-insensitive search filter on name', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await seedCampaign(admin.id, { name: 'Diwali Push' });
    await seedCampaign(admin.id, { name: 'Diwali Influencer' });
    await seedCampaign(admin.id, { name: 'Winter Sale' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/campaigns?search=diwali'),
    );

    const body = await getJson<{ total: number }>(res);
    expect(body!.total).toBe(2);
  });

  it('respects page + pageSize', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    for (let i = 0; i < 5; i += 1) {
      await seedCampaign(admin.id, { name: `Campaign ${i}` });
    }
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/campaigns?page=2&pageSize=2',
      ),
    );

    const body = await getJson<{
      items: unknown[];
      total: number;
      page: number;
      pageSize: number;
    }>(res);
    expect(body!.total).toBe(5);
    expect(body!.page).toBe(2);
    expect(body!.pageSize).toBe(2);
    expect(body!.items).toHaveLength(2);
  });

  it('returns 400 when query params are invalid (page=0)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/campaigns?page=0'),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/campaigns
// ---------------------------------------------------------------------------

describe('POST /api/campaigns — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: 'Anon Campaign',
        channel: 'META_ADS',
        startDate: '2026-05-16T00:00:00Z',
        budget: 5000,
      }),
    );
    expect(res.status).toBe(401);
    expect(await prisma.campaign.count()).toBe(0);
  });
});

describe('POST /api/campaigns — happy path', () => {
  it('admin creates a campaign and the row + audit log are written', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: 'Diwali Push 2026',
        channel: 'META_ADS',
        status: 'ACTIVE',
        startDate: '2026-10-15T00:00:00Z',
        endDate: '2026-11-05T00:00:00Z',
        budget: 250_000,
        utmCampaign: 'diwali_push_2026',
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{
      id: string;
      name: string;
      ownerId: string;
      status: CampaignStatus;
      channel: CampaignChannel;
      owner: { id: string } | null;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.name).toBe('Diwali Push 2026');
    expect(body!.channel).toBe(CampaignChannel.META_ADS);
    expect(body!.status).toBe(CampaignStatus.ACTIVE);
    expect(body!.ownerId).toBe(admin.id);
    expect(body!.owner).not.toBeNull();
    expect(body!.owner!.id).toBe(admin.id);

    const stored = await prisma.campaign.findUnique({
      where: { id: body!.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.ownerId).toBe(admin.id);
    expect(stored!.utmCampaign).toBe('diwali_push_2026');

    // `campaign.created` activity log row tied to the calling admin.
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'campaign.created',
        entityType: 'campaign',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({ entityName: 'Diwali Push 2026' });
  });

  it('employee creates a campaign owned by themselves (default ownerId = caller)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: 'Employee-led Campaign',
        channel: 'INSTAGRAM_ORGANIC',
        startDate: '2026-06-01T00:00:00Z',
        budget: 5000,
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ ownerId: string }>(res);
    expect(body!.ownerId).toBe(employee.id);

    const stored = await prisma.campaign.findFirst({
      where: { name: 'Employee-led Campaign' },
    });
    expect(stored).not.toBeNull();
    expect(stored!.ownerId).toBe(employee.id);
  });

  it('admin can assign a new campaign to any user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: "Alice's Campaign",
        channel: 'META_ADS',
        startDate: '2026-06-01T00:00:00Z',
        budget: 7500,
        ownerId: alice.id,
      }),
    );

    expect(res.status).toBe(201);
    const body = await getJson<{ ownerId: string }>(res);
    expect(body!.ownerId).toBe(alice.id);
  });
});

describe('POST /api/campaigns — RBAC on cross-assignment', () => {
  it('returns 403 when an EMPLOYEE attempts to assign a new campaign to another user', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: other } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: 'Cross-assigned Campaign',
        channel: 'META_ADS',
        startDate: '2026-06-01T00:00:00Z',
        budget: 5000,
        ownerId: other.id,
      }),
    );

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');

    // Defensive: no row written.
    expect(await prisma.campaign.count()).toBe(0);
  });
});

describe('POST /api/campaigns — validation', () => {
  it('returns 400 when the body is missing required fields', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        // Missing name, channel, startDate, budget.
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.campaign.count()).toBe(0);
  });

  it('returns 400 when endDate is before startDate', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/campaigns', {
        name: 'Inverted Range',
        channel: 'META_ADS',
        startDate: '2026-06-10T00:00:00Z',
        endDate: '2026-06-01T00:00:00Z',
        budget: 5000,
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.campaign.count()).toBe(0);
  });

  it('returns 400 when the body is not JSON', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const req = new Request('http://test/api/campaigns', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json-at-all',
    }) as unknown as Parameters<typeof POST>[0];

    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
