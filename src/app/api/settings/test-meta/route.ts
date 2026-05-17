/**
 * `POST /api/settings/test-meta` — admin-only "Test connection"
 * pingback for the Meta Marketing API (SPEC.md §12.1, v0.1.3).
 *
 * The route is a thin orchestrator:
 *
 *   1. `requireAdminSession()` → 401/403.
 *   2. `resolveMetaConfig()` → 400 (`meta_not_configured`) if any of
 *      the required Setting rows are missing or the access token can't
 *      be decrypted.
 *   3. `testMetaConnection(config)` → 200 with `{ ok: true, meName }`
 *      on success, 502 with `{ error }` on a platform-level failure
 *      (expired token, missing scope, throttled, etc.).
 *   4. Best-effort audit log row `settings.meta_test` with
 *      `{ ok, error? }`. Plaintext credentials never appear in the
 *      metadata (SPEC.md §12.2).
 *
 * The body is intentionally empty: the route reads the live config
 * from the DB rather than accepting a payload, so the operator tests
 * what's actually stored (not what they happen to have typed in the
 * form but haven't saved yet).
 *
 * TODO(v0.1.4): wire up Meta /insights sync — once the v0.1.4 spend
 * fetcher lands, this route should additionally probe
 * `/<adAccountId>/insights?fields=spend&limit=1` so the admin gets
 * end-to-end confirmation that the Ad Account itself is reachable.
 */

import { NextResponse } from 'next/server';

import { prisma } from '@/lib/db';
import { errorResponse, requireAdminSession } from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import {
  resolveMetaConfig,
  testMetaConnection,
} from '@/lib/integrations/meta';

// `fetch` to graph.facebook.com is fine on Edge in principle, but
// `resolveMetaConfig` reads from Prisma which is Node-only — pin the
// runtime accordingly.
export const runtime = 'nodejs';

// Always reflect the latest stored credentials; never cache.
export const dynamic = 'force-dynamic';

export async function POST(): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();

    const config = await resolveMetaConfig();
    if (config === null) {
      // Mirror the SMTP route's "not configured" convention so the UI
      // can distinguish "the operator needs to fill the form" from
      // "the credentials are wrong" (502 below).
      return NextResponse.json(
        {
          error: 'meta_not_configured',
          message:
            'Meta credentials are incomplete. Paste an access token and Ad Account ID, then save.',
        },
        { status: 400 },
      );
    }

    const result = await testMetaConnection(config);

    // Audit log goes through whether or not the call succeeded — the
    // operator's intent (pressed "Test connection") is itself the
    // signal, and a string of failures is useful to spot in the
    // activity feed.
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: ACTIVITY_ACTIONS.SETTINGS_META_TEST,
        entityType: 'setting',
        entityId: 'meta_access_token',
        metadata: result.ok
          ? { ok: true, entityName: 'Meta' }
          : { ok: false, error: result.error, entityName: 'Meta' },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/settings/test-meta] activity log failed', logErr);
    }

    if (!result.ok) {
      // Platform-level failure → 502 Bad Gateway. We did our job
      // (admin auth, config check, network call) but the upstream
      // refused the request. Echoing `error` lets the UI surface
      // Meta's verbatim diagnostic.
      return NextResponse.json({ ok: false, error: result.error }, { status: 502 });
    }

    return NextResponse.json({ ok: true, meName: result.meName });
  } catch (err) {
    return errorResponse(err);
  }
}
