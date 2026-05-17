/**
 * Integration tests for `GET /api/campaigns/comparison` (task 44).
 *
 * Validates: Requirements 6.3, 13.1, 13.2, 15.2, 15.3
 * Spec references: SPEC.md §7.2.6, §7.3, §16.2.
 *
 * Coverage matrix per SPEC §16.2 + the task brief:
 *
 *   Endpoint                       Happy   401     400 (zod)
 *   GET /api/campaigns/comparison    ✓       ✓       ✓
 *
 * Per the task brief:
 *   - Returns spend / signups / CAC by channel for the supplied
 *     window (the marketing UI defaults to the last 30 days).
 *   - 401 without a session.
 *
 * The route requires `dateFrom` and `dateTo` (both ISO datetime
 * strings) — see `campaignComparisonQuerySchema` in
 * `src/lib/schemas/campaigns.ts`. We use a deterministic 30-day
 * window so the test is independent of `Date.now()`.
 */

import { describe, expect, it } from 'vitest';
import {
  CampaignChannel,
  CampaignStatus,
  LeadSource,
  LeadStatus,
  Priority,
} from '@prisma/client';

import { GET } from '@/app/api/campaigns/comparison/route';
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

const WINDOW_FROM = '2026-05-01T00:00:00Z';
const WINDOW_TO = '2026-05-31T23:59:59Z';

interface SeedCampaignOverrides {
  channel: CampaignChannel;
  spent: number;
  startDate: Date;
  utmCampaign: string;
  ownerId: string;
  budget?: number;
}

async function seedCampaign(
  overrides: SeedCampaignOverrides,
): Promise<{ id: string; utmCampaign: string }> {
  const campaign = await prisma.campaign.create({
    data: {
      name: `Campaign ${overrides.utmCampaign}`,
      channel: overrides.channel,
      status: CampaignStatus.ACTIVE,
      startDate: overrides.startDate,
      budget: overrides.budget ?? 100_000,
      spent: overrides.spent,
      ownerId: overrides.ownerId,
      utmCampaign: overrides.utmCampaign,
    },
    select: { id: true, utmCampaign: true },
  });
  return { id: campaign.id, utmCampaign: campaign.utmCampaign as string };
}

async function seedLead(
  createdById: string,
  utmCampaign: string,
  status: LeadStatus,
  createdAt: Date,
): Promise<void> {
  await prisma.lead.create({
    data: {
      name: `Lead ${utmCampaign}`,
      source: LeadSource.MANUAL,
      status,
      priority: Priority.MEDIUM,
      ownerId: createdById,
      createdById,
      utmCampaign,
      createdAt,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

describe('GET /api/campaigns/comparison — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/comparison?dateFrom=${WINDOW_FROM}&dateTo=${WINDOW_TO}`,
      ),
    );
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('GET /api/campaigns/comparison — validation', () => {
  it('returns 400 when required dateFrom/dateTo params are missing', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest('GET', 'http://test/api/campaigns/comparison'),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
  });

  it('returns 400 when dateFrom > dateTo', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        'http://test/api/campaigns/comparison?dateFrom=2026-06-01T00:00:00Z&dateTo=2026-05-01T00:00:00Z',
      ),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('GET /api/campaigns/comparison — happy path', () => {
  it('returns an empty channels array when no campaigns ran inside the window', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/comparison?dateFrom=${WINDOW_FROM}&dateTo=${WINDOW_TO}`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{ channels: unknown[] }>(res);
    expect(body).not.toBeNull();
    expect(body!.channels).toEqual([]);
  });

  it('aggregates spend, leads, conversions, and CAC by channel for the window', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    // Two META_ADS campaigns inside the window with their own UTM tags.
    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.META_ADS,
      spent: 10_000,
      startDate: new Date('2026-05-05T00:00:00Z'),
      utmCampaign: 'meta_a',
    });
    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.META_ADS,
      spent: 5_000,
      startDate: new Date('2026-05-15T00:00:00Z'),
      utmCampaign: 'meta_b',
    });
    // One GOOGLE_ADS campaign inside the window.
    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.GOOGLE_ADS,
      spent: 20_000,
      startDate: new Date('2026-05-10T00:00:00Z'),
      utmCampaign: 'google_a',
    });
    // One YOUTUBE campaign OUTSIDE the window (April) — should be ignored.
    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.YOUTUBE,
      spent: 99_000,
      startDate: new Date('2026-04-01T00:00:00Z'),
      utmCampaign: 'youtube_outside',
    });

    // Leads inside the window:
    //  - META_ADS (meta_a): 3 total, 1 CONVERTED.
    //  - META_ADS (meta_b): 1 total, 0 CONVERTED.
    //  - GOOGLE_ADS (google_a): 2 total, 2 CONVERTED.
    //  - One lead OUTSIDE the window — must be ignored.
    //  - One lead with a non-matching UTM tag — must be ignored.
    const inWindow = new Date('2026-05-20T00:00:00Z');
    const outsideWindow = new Date('2026-04-15T00:00:00Z');

    await seedLead(admin.id, 'meta_a', LeadStatus.NEW, inWindow);
    await seedLead(admin.id, 'meta_a', LeadStatus.CONVERTED, inWindow);
    await seedLead(admin.id, 'meta_a', LeadStatus.CONTACTED, inWindow);
    await seedLead(admin.id, 'meta_b', LeadStatus.NEW, inWindow);
    await seedLead(admin.id, 'google_a', LeadStatus.CONVERTED, inWindow);
    await seedLead(admin.id, 'google_a', LeadStatus.CONVERTED, inWindow);
    // Outside the window — even though the UTM tag matches.
    await seedLead(admin.id, 'meta_a', LeadStatus.CONVERTED, outsideWindow);
    // Non-matching UTM tag.
    await seedLead(admin.id, 'orphan', LeadStatus.CONVERTED, inWindow);

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/comparison?dateFrom=${WINDOW_FROM}&dateTo=${WINDOW_TO}`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      channels: Array<{
        channel: CampaignChannel;
        campaignCount: number;
        totalSpent: number;
        totalLeads: number;
        totalConversions: number;
        cac: number | null;
        cpl: number | null;
        conversionRate: number | null;
      }>;
    }>(res);
    expect(body).not.toBeNull();

    // YOUTUBE campaign was outside the window → not in the rollup.
    const channels = body!.channels;
    expect(channels.map((c) => c.channel).sort()).toEqual([
      CampaignChannel.GOOGLE_ADS,
      CampaignChannel.META_ADS,
    ]);

    const meta = channels.find((c) => c.channel === CampaignChannel.META_ADS);
    expect(meta).toBeDefined();
    expect(meta!.campaignCount).toBe(2);
    expect(meta!.totalSpent).toBe(15_000);
    // 3 leads on meta_a + 1 lead on meta_b = 4.
    expect(meta!.totalLeads).toBe(4);
    // Only 1 lead inside the window converted (meta_a).
    expect(meta!.totalConversions).toBe(1);
    expect(meta!.cac).toBe(15_000 / 1);
    expect(meta!.cpl).toBe(15_000 / 4);
    expect(meta!.conversionRate).toBeCloseTo(1 / 4);

    const google = channels.find(
      (c) => c.channel === CampaignChannel.GOOGLE_ADS,
    );
    expect(google).toBeDefined();
    expect(google!.campaignCount).toBe(1);
    expect(google!.totalSpent).toBe(20_000);
    expect(google!.totalLeads).toBe(2);
    expect(google!.totalConversions).toBe(2);
    expect(google!.cac).toBe(20_000 / 2);
    expect(google!.cpl).toBe(20_000 / 2);
    expect(google!.conversionRate).toBe(1);
  });

  it('returns null CAC / CPL / conversionRate when there are no leads/conversions for a channel', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.EMAIL,
      spent: 4_000,
      startDate: new Date('2026-05-05T00:00:00Z'),
      utmCampaign: 'email_only',
    });
    // No leads attributed to this campaign.

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/comparison?dateFrom=${WINDOW_FROM}&dateTo=${WINDOW_TO}`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      channels: Array<{
        channel: CampaignChannel;
        totalLeads: number;
        totalConversions: number;
        cac: number | null;
        cpl: number | null;
        conversionRate: number | null;
      }>;
    }>(res);
    expect(body!.channels).toHaveLength(1);
    const email = body!.channels[0]!;
    expect(email.channel).toBe(CampaignChannel.EMAIL);
    expect(email.totalLeads).toBe(0);
    expect(email.totalConversions).toBe(0);
    expect(email.cac).toBeNull();
    expect(email.cpl).toBeNull();
    expect(email.conversionRate).toBeNull();
  });

  it('respects the channel filter for drilldown views', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.META_ADS,
      spent: 10_000,
      startDate: new Date('2026-05-05T00:00:00Z'),
      utmCampaign: 'meta_filter',
    });
    await seedCampaign({
      ownerId: admin.id,
      channel: CampaignChannel.GOOGLE_ADS,
      spent: 7_500,
      startDate: new Date('2026-05-10T00:00:00Z'),
      utmCampaign: 'google_filter',
    });

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await GET(
      buildJsonRequest(
        'GET',
        `http://test/api/campaigns/comparison?dateFrom=${WINDOW_FROM}&dateTo=${WINDOW_TO}&channel=META_ADS`,
      ),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      channels: Array<{ channel: CampaignChannel }>;
    }>(res);
    expect(body!.channels).toHaveLength(1);
    expect(body!.channels[0]!.channel).toBe(CampaignChannel.META_ADS);
  });
});
