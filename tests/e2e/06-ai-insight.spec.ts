/**
 * E2E flow #6 — AI insight generation (SPEC §16.3 critical flow #6, task 96).
 *
 * This spec exercises the REAL `POST /api/ai/generate` route end-to-end.
 * The Anthropic SDK call inside `src/lib/claude.ts` short-circuits to a
 * deterministic mock when `MOCK_ANTHROPIC=1` is set on the dev-server
 * process (Playwright sets it via `webServer.env` — see
 * `playwright.config.ts` and FIX-LIST.md §2). That way the spec covers
 * the full Next.js → route handler → `generateScopeInsight` → Prisma →
 * ActivityLog path without a live network call to Anthropic.
 *
 * SEED-THEN-POST pattern (panel-audit gap B1, v0.1.2):
 *
 *   `cleanupTestData()` runs in `beforeEach` and wipes Lead, Campaign,
 *   AIInsight, ActivityLog (etc.). Against the resulting empty DB, the
 *   `ads`-scope aggregation in `src/lib/ai-insights.ts` returns
 *   `current=0, previous=0`, which triggers the insufficient-data
 *   short-circuit (lines ~254-266) — Claude is never called, the
 *   persisted summary becomes "Insufficient data for this period", and
 *   the assertion on the mocked summary fails.
 *
 *   To actually exercise the Claude-mock path, we seed exactly one
 *   `Campaign` row whose active window overlaps the requested period
 *   (last 7 days) and whose `signups > 0`. That bumps
 *   `data.summary.totalSignups` above zero, the short-circuit is
 *   bypassed, and `getClaudeClient()` returns the mock — which yields
 *   the well-known "Mocked insight for E2E run." summary the assertions
 *   below look for.
 *
 *   We use `'ads'` rather than `'overall'` because it has the simplest
 *   non-zero condition (one Campaign row with positive `signups`).
 */

import { test, expect } from '@playwright/test';
import { CampaignChannel, CampaignStatus, PrismaClient } from '@prisma/client';

import {
  E2E_ADMIN_EMAIL,
  cleanupTestData,
  disconnectPrisma,
  loginAsAdmin,
  seedAdmin,
} from './helpers';

// ---------------------------------------------------------------------------
// Local Prisma client
// ---------------------------------------------------------------------------
//
// The shared `helpers.ts` keeps its `PrismaClient` private so each
// spec uses its own connection for direct DB verification. This mirrors
// the pattern documented at the top of `helpers.ts`: keeping the
// test pool separate from the dev server's pool means a teardown
// here can never close a connection the server is using.

let prisma: PrismaClient | undefined;

function getPrisma(): PrismaClient {
  if (!prisma) {
    prisma = new PrismaClient();
  }
  return prisma;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await seedAdmin();
});

test.beforeEach(async () => {
  // Wipes `AIInsight` and `ActivityLog` (among others) so each test
  // starts with an empty feed and audit log. The mocked POST below
  // therefore creates the only row visible to the assertions.
  await cleanupTestData();
});

test.afterAll(async () => {
  // Disconnect both the helper-scoped pool and the spec-scoped one we
  // opened above so the test process exits cleanly.
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
  await disconnectPrisma();
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test('AI insight: generate via real /api/ai/generate route (MOCK_ANTHROPIC)', async ({
  page,
}) => {
  // 1. Authenticate as the seeded admin. The /api/ai/generate route is
  //    admin-gated (SPEC §10.5) and uses the same cookie-based session
  //    that the browser will carry into `page.request`.
  await loginAsAdmin(page);

  // 2. Seed one Campaign so the `ads`-scope aggregation's headline
  //    metric (`summary.totalSignups`) is non-zero. Without this, the
  //    insufficient-data short-circuit in `generateScopeInsight`
  //    persists the canned "Insufficient data for this period" summary
  //    and never calls the Claude mock — the assertion on
  //    "Mocked insight for E2E run." would then fail. The Campaign's
  //    active window must overlap the requested period; we make it
  //    span the last 7 days exactly.
  //
  //    We resolve the admin's id once here so the Campaign FK is
  //    correctly attributed and the audit-log assertion at the end
  //    keys on the same user the route saw.
  const admin = await getPrisma().user.findUniqueOrThrow({
    where: { email: E2E_ADMIN_EMAIL },
    select: { id: true },
  });

  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  await getPrisma().campaign.create({
    data: {
      name: 'E2E Seed Campaign',
      channel: CampaignChannel.META_ADS,
      status: CampaignStatus.ACTIVE,
      // startDate sits comfortably inside the [periodStart, periodEnd]
      // window so `activeDuringWindow` (in src/lib/aggregations/ads.ts)
      // matches it for both the current window's `startDate <= end`
      // check and any future endDate-based filtering.
      startDate: new Date(periodEnd.getTime() - 3 * 24 * 60 * 60 * 1000),
      // endDate left null → "campaign still running", which the
      // aggregator's `OR: [{ endDate: { gte: start } }, { endDate: null }]`
      // branch accepts unconditionally.
      endDate: null,
      budget: 50_000,
      spent: 1_000,
      signups: 10,
      utmCampaign: 'e2e_seed',
      ownerId: admin.id,
    },
  });

  // 3. Fire the real POST. `page.request` re-uses the browser context's
  //    cookies, so the route sees the authenticated admin. The dev
  //    server has MOCK_ANTHROPIC=1 set (via `webServer.env` in
  //    `playwright.config.ts`), so `getClaudeClient()` returns the
  //    deterministic mock and the response body is well-known.
  const response = await page.request.post('/api/ai/generate', {
    data: {
      scope: 'ads',
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    },
  });
  expect(response.status()).toBe(201);
  const insight = (await response.json()) as { id: string; suggestion: string };
  expect(insight.id).toBeTruthy();

  // 4. Navigate to /ai and assert the mocked summary renders. The page
  //    is `force-dynamic`, so the freshly-persisted row shows up on the
  //    next load without cache-busting tricks.
  await page.goto('/ai');
  await expect(page).toHaveURL(/\/ai(\/|$|\?)/);
  await expect(
    page.getByText('Mocked insight for E2E run.'),
  ).toBeVisible({ timeout: 15_000 });

  // 5. Click through to the detail page. The card footer renders a
  //    "View details" link wrapped by a Button — `getByRole('link')`
  //    reaches it regardless of the underlying styling.
  await page.getByRole('link', { name: /view details/i }).click();
  await expect(page).toHaveURL(new RegExp(`/ai/${insight.id}(/|$|\\?)`));

  // 6. The suggestion lives in the detail card body. A substring match
  //    on the mocked copy is enough to prove the row hydrated end-to-end.
  await expect(
    page.getByText(/double down on top-performing creative/i),
  ).toBeVisible();

  // 7. Verify the audit log row was written. The route handler calls
  //    `generateScopeInsight({ userId, ... })` which writes an
  //    `ai.insight_generated` ActivityLog row keyed to the admin's id
  //    (`admin` was resolved at step 2 above).
  const logRow = await getPrisma().activityLog.findFirst({
    where: {
      action: 'ai.insight_generated',
      userId: admin.id,
    },
  });
  expect(logRow).not.toBeNull();
});
