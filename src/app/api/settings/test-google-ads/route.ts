/**
 * `POST /api/settings/test-google-ads` — admin-only "Test connection"
 * pingback for the Google Ads API (SPEC.md §12.1, v0.1.3).
 *
 * The route is a thin orchestrator:
 *
 *   1. `requireAdminSession()` → 401/403.
 *   2. `resolveGoogleAdsConfig()` → 400
 *      (`google_ads_not_configured`) if any of the five required
 *      Setting rows are missing or one of the encrypted blobs can't
 *      be decrypted.
 *   3. `testGoogleAdsConnection(config)` → 200 on success, 502 with
 *      `{ error }` on a platform-level failure. The probe is a single
 *      OAuth-token refresh — the full Google Ads gRPC client is
 *      v0.1.4 work.
 *   4. Best-effort audit log row `settings.google_ads_test` with
 *      `{ ok, error? }`. Plaintext credentials never appear in the
 *      metadata (SPEC.md §12.2).
 *
 * The body is intentionally empty: the route reads the live config
 * from the DB rather than accepting a payload.
 *
 * TODO(v0.1.4): wire up Google Ads /searchStream sync — additionally
 * hit `customers/<id>/googleAds:searchStream` with a trivial
 * `SELECT customer.id FROM customer` query so the admin gets
 * end-to-end confirmation that the developer-token approval has
 * landed.
 */

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { errorResponse, requireAdminSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  resolveGoogleAdsConfig,
  testGoogleAdsConnection,
} from '@/lib/integrations/google-ads';

// Prisma + decrypt are Node-only.
export const runtime = 'nodejs';

// Always reflect the latest stored credentials; never cache.
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const config = await resolveGoogleAdsConfig();
    if (config === null) {
      return NextResponse.json(
        {
          error: 'google_ads_not_configured',
          message:
            'Google Ads credentials are incomplete. Paste the developer token, customer ID, and the OAuth client + refresh token, then save.',
        },
        { status: 400 },
      );
    }

    const result = await testGoogleAdsConnection(config);

    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.SETTINGS_GOOGLE_ADS_TEST,
        entityType: 'setting',
        entityId: 'google_ads_refresh_token',
        metadata: result.ok
          ? { ok: true, entityName: 'Google Ads' }
          : { ok: false, error: result.error, entityName: 'Google Ads' },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error(
        '[api/settings/test-google-ads] activity log failed',
        logErr,
      );
    }

    if (!result.ok) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    }

    return NextResponse.json({ ok: true, refreshOk: true });
  } catch (err) {
    return errorResponse(err);
  }
}
