/**
 * Integration tests for `POST /api/ai/generate` (task 69).
 *
 * Validates: Requirements 15.2, 15.3, 15.4
 * Spec references: SPEC.md §10.5, §10.7, §16.2.
 *
 * The route is admin-only and runs the shared `generateScopeInsight`
 * pipeline (`src/lib/ai-insights.ts`):
 *
 *   1. Auth → 401 without session, 403 for non-admin (employee).
 *   2. Validation → 400 on missing/invalid body (`aiGenerateSchema`).
 *   3. Aggregate metrics for current and previous windows.
 *   4. Compute the trend in code (`computeTrend`) — Claude's
 *      `trend`/`trendPct` are deliberately *overridden* so the numeric
 *      answer is deterministic (SPEC.md §10.2 feature 3).
 *   5. Insufficient-data short-circuit — both current and previous
 *      headline metrics are zero → persist the canned "Insufficient
 *      data" insight without calling Claude (SPEC.md §10.7).
 *   6. On success, persist `AIInsight` and best-effort log
 *      `ai.insight_generated` to `ActivityLog`.
 *
 * Mocking strategy:
 *
 *   • `@anthropic-ai/sdk` is mocked with `vi.mock` so no real API call
 *     ever happens. The mock module exports a default constructor
 *     (`vi.fn(() => ({ messages: { create } }))`) whose `create`
 *     resolves to whatever was last installed via `setClaudeResponse`.
 *     If a test's code path is supposed to short-circuit before Claude
 *     (the insufficient-data case), `nextResponse` is left `null` so
 *     any accidental call throws a recognisable error.
 *
 *   • `__resetClaudeClientForTests()` from `@/lib/claude` clears the
 *     module-scoped SDK cache between tests so the mock is rebuilt
 *     after `setup.ts`'s `vi.clearAllMocks()` runs.
 *
 *   • `claudeState` is declared via `vi.hoisted(...)` so the mock
 *     factory can close over it — Vitest hoists `vi.mock(...)` above
 *     ordinary imports, but ordinary `const` declarations stay where
 *     they sit, so referencing them from the factory would TDZ.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CampaignChannel,
  CampaignStatus,
  type ActivityLog,
  type AIInsight,
} from '@prisma/client';

import { POST } from '@/app/api/ai/generate/route';
import { __resetClaudeClientForTests } from '@/lib/claude';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Mock @anthropic-ai/sdk
// ---------------------------------------------------------------------------

/**
 * Shared mock state. Hoisted so the `vi.mock` factory below can close
 * over it — Vitest runs `vi.hoisted(...)` before module evaluation, so
 * this is initialised before the SDK constructor is called from
 * `claude.ts`.
 */
const { claudeState } = vi.hoisted(() => ({
  claudeState: {
    nextResponse: null as unknown,
    callCount: 0,
  },
}));

vi.mock('@anthropic-ai/sdk', () => {
  const create = vi.fn(async () => {
    claudeState.callCount += 1;
    if (claudeState.nextResponse == null) {
      throw new Error('claude mock not configured');
    }
    return claudeState.nextResponse;
  });
  return {
    // `import Anthropic from '@anthropic-ai/sdk'` resolves to this.
    // `new Anthropic({ apiKey })` invokes the function as a constructor;
    // a plain `vi.fn` returning an object yields that object from `new`.
    default: vi.fn(() => ({ messages: { create } })),
  };
});

interface CannedClaudePayload {
  trend: 'up' | 'down' | 'flat';
  trendPct: number;
  summary: string;
  suggestion: string;
}

/** Install a canned response Claude's `messages.create(...)` will return next. */
function setClaudeResponse(payload: CannedClaudePayload): void {
  claudeState.nextResponse = {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  claudeState.nextResponse = null;
  claudeState.callCount = 0;
  // Force `getClaudeClient` to rebuild on the next call so the mocked
  // SDK constructor runs again after `setup.ts`'s `vi.clearAllMocks()`.
  __resetClaudeClientForTests();
  // The route only needs *something* truthy here — `resolveApiKey()`
  // checks `process.env.ANTHROPIC_API_KEY` first and short-circuits
  // before ever touching the (mocked) Setting table.
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
});

// ---------------------------------------------------------------------------
// Local helpers / fixtures
// ---------------------------------------------------------------------------

/**
 * Default analysis window used by most tests. The 7-day duration matches
 * SPEC.md §10.4 ("Comparison: previous 7 days") and gives the
 * `generateScopeInsight` pipeline a clean previous window of
 * `[2026-04-30T23:59:59.999Z, 2026-05-07T23:59:59.999Z]`.
 */
const PERIOD_START = new Date('2026-05-08T00:00:00.000Z');
const PERIOD_END = new Date('2026-05-15T00:00:00.000Z');

/** A timestamp comfortably inside the current period. */
const IN_CURRENT = new Date('2026-05-10T12:00:00.000Z');

/** A timestamp comfortably inside the previous period. */
const IN_PREVIOUS = new Date('2026-05-03T12:00:00.000Z');

/**
 * Build the canonical happy-path body. Tests can override fields by
 * spreading the result.
 */
function buildBody(
  scope: 'ads' | 'social' | 'leads' | 'overall' = 'ads',
): {
  scope: 'ads' | 'social' | 'leads' | 'overall';
  periodStart: string;
  periodEnd: string;
} {
  return {
    scope,
    periodStart: PERIOD_START.toISOString(),
    periodEnd: PERIOD_END.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('POST /api/ai/generate — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', buildBody()),
    );

    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
    // No insight written and Claude never invoked.
    expect(await prisma.aIInsight.count()).toBe(0);
    expect(claudeState.callCount).toBe(0);
  });

  it('returns 403 when an EMPLOYEE attempts to generate (admin-only per SPEC §10.5)', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', buildBody()),
    );

    expect(res.status).toBe(403);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('forbidden');
    expect(await prisma.aIInsight.count()).toBe(0);
    expect(claudeState.callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('POST /api/ai/generate — validation', () => {
  it('returns 400 when the body is missing required fields (no scope)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', {
        // Missing scope.
        periodStart: PERIOD_START.toISOString(),
        periodEnd: PERIOD_END.toISOString(),
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string; issues: unknown[] }>(res);
    expect(body!.error).toBe('bad_request');
    expect(Array.isArray(body!.issues)).toBe(true);
    expect(await prisma.aIInsight.count()).toBe(0);
  });

  it('returns 400 when periodStart is on or after periodEnd', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', {
        scope: 'ads',
        periodStart: PERIOD_END.toISOString(),
        periodEnd: PERIOD_START.toISOString(),
      }),
    );

    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
    expect(await prisma.aIInsight.count()).toBe(0);
    expect(claudeState.callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Happy path (ads) — local trend overrides Claude, audit row written
// ---------------------------------------------------------------------------

describe('POST /api/ai/generate — happy path (ads scope)', () => {
  it("persists an AIInsight with Claude's narrative and the locally-computed trend, then logs activity", async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Two campaigns chosen so the ads aggregator sees a distinct
    // signups total in each window:
    //
    //   • Campaign A — active only in current window (totalSignups=100)
    //   • Campaign B — active only in previous window (totalSignupsPrev=50)
    //
    // `computeTrend(100, 50)` therefore yields `{ trend: 'up',
    // trendPct: 100 }` — clearly different from Claude's canned
    // `flat` / 0 below, so we can assert the override happened.
    await prisma.campaign.create({
      data: {
        name: 'Current-window campaign',
        channel: CampaignChannel.META_ADS,
        status: CampaignStatus.ACTIVE,
        startDate: new Date('2026-05-09T00:00:00.000Z'),
        endDate: new Date('2026-05-14T00:00:00.000Z'),
        budget: 50_000,
        spent: 10_000,
        signups: 100,
        ownerId: admin.id,
      },
    });
    await prisma.campaign.create({
      data: {
        name: 'Previous-window campaign',
        channel: CampaignChannel.META_ADS,
        status: CampaignStatus.ENDED,
        startDate: new Date('2026-05-01T00:00:00.000Z'),
        endDate: new Date('2026-05-06T00:00:00.000Z'),
        budget: 25_000,
        spent: 5_000,
        signups: 50,
        ownerId: admin.id,
      },
    });

    setClaudeResponse({
      trend: 'flat',
      trendPct: 0,
      summary: 'Test summary',
      suggestion: 'Test suggestion',
    });

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', buildBody('ads')),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body).not.toBeNull();
    expect(body!.scope).toBe('ads');
    // Narrative comes from Claude verbatim.
    expect(body!.summary).toBe('Test summary');
    expect(body!.suggestion).toBe('Test suggestion');
    // Trend is computed locally — Claude's `flat` / 0 is overridden.
    expect(body!.trend).toBe('up');
    expect(body!.trendPct).toBe(100);
    // input_tokens (100) + output_tokens (50) = 150.
    expect(body!.tokenUsage).toBe(150);

    // Claude was called exactly once.
    expect(claudeState.callCount).toBe(1);

    // Row landed in the DB.
    const stored = await prisma.aIInsight.findUnique({
      where: { id: body!.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe('Test summary');
    expect(stored!.tokenUsage).toBe(150);

    // Audit log row written with the right action / entity / metadata.
    const log = (await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'ai.insight_generated',
        entityType: 'ai_insight',
        entityId: body!.id,
      },
    })) as ActivityLog | null;
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({
      scope: 'ads',
      trend: 'up',
      trendPct: 100,
    });
  });
});

// ---------------------------------------------------------------------------
// Insufficient-data short-circuit
// ---------------------------------------------------------------------------

describe('POST /api/ai/generate — insufficient data', () => {
  it('persists an "Insufficient data" insight without calling Claude when both windows are empty', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // No campaigns at all → totalSignups === 0 in both windows →
    // generateScopeInsight short-circuits before invoking Claude.
    // We deliberately leave `claudeState.nextResponse` null so any
    // accidental call would throw "claude mock not configured".

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', buildBody('ads')),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body).not.toBeNull();
    expect(body!.summary).toBe('Insufficient data for this period');
    expect(body!.tokenUsage).toBe(0);
    // Claude must NOT have been invoked — that's the whole point of
    // the short-circuit (SPEC §10.7).
    expect(claudeState.callCount).toBe(0);

    // Row persisted.
    const stored = await prisma.aIInsight.findUnique({
      where: { id: body!.id },
    });
    expect(stored).not.toBeNull();
    expect(stored!.summary).toBe('Insufficient data for this period');
    expect(stored!.tokenUsage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// All four scopes — smoke test
// ---------------------------------------------------------------------------

describe('POST /api/ai/generate — all four scopes (smoke)', () => {
  /**
   * Canned Claude response shared by every smoke test. Specifics don't
   * matter — we only assert that the route returns 201 and writes a row.
   */
  const SMOKE_RESPONSE: CannedClaudePayload = {
    trend: 'up',
    trendPct: 50,
    summary: 'Smoke summary',
    suggestion: 'Smoke suggestion',
  };

  it('ads scope: returns 201 with seeded campaign data', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    await prisma.campaign.create({
      data: {
        name: 'Smoke ads campaign',
        channel: CampaignChannel.META_ADS,
        status: CampaignStatus.ACTIVE,
        startDate: new Date('2026-05-09T00:00:00.000Z'),
        endDate: new Date('2026-05-14T00:00:00.000Z'),
        budget: 5_000,
        spent: 1_000,
        signups: 10,
        ownerId: admin.id,
      },
    });

    setClaudeResponse(SMOKE_RESPONSE);

    const res = await POST(
      buildJsonRequest('POST', 'http://test/api/ai/generate', buildBody('ads')),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body!.scope).toBe('ads');
  });

  it('social scope: returns 201 with a published post in the current window', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    await prisma.socialPost.create({
      data: {
        platform: 'INSTAGRAM',
        status: 'PUBLISHED',
        caption: 'Smoke post',
        publishedAt: IN_CURRENT,
        likes: 10,
        comments: 2,
        shares: 1,
        reach: 100,
        ownerId: admin.id,
      },
    });

    setClaudeResponse(SMOKE_RESPONSE);

    const res = await POST(
      buildJsonRequest(
        'POST',
        'http://test/api/ai/generate',
        buildBody('social'),
      ),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body!.scope).toBe('social');
  });

  it('leads scope: returns 201 with a lead created in the current window', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    await prisma.lead.create({
      data: {
        name: 'Smoke Lead',
        source: 'WEBSITE',
        status: 'NEW',
        createdById: admin.id,
        createdAt: IN_CURRENT,
      },
    });

    setClaudeResponse(SMOKE_RESPONSE);

    const res = await POST(
      buildJsonRequest(
        'POST',
        'http://test/api/ai/generate',
        buildBody('leads'),
      ),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body!.scope).toBe('leads');
  });

  it('overall scope: returns 201 with cross-module data in the current window', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    // Headline metric for the overall scope is `leads.current` —
    // seed one lead so we clear the insufficient-data short-circuit.
    await prisma.lead.create({
      data: {
        name: 'Smoke Lead Overall',
        source: 'WEBSITE',
        status: 'NEW',
        createdById: admin.id,
        createdAt: IN_CURRENT,
      },
    });
    // Some non-leads activity to make the rawData snapshot meaningful.
    await prisma.lead.create({
      data: {
        name: 'Smoke Lead Prev',
        source: 'WEBSITE',
        status: 'NEW',
        createdById: admin.id,
        createdAt: IN_PREVIOUS,
      },
    });

    setClaudeResponse(SMOKE_RESPONSE);

    const res = await POST(
      buildJsonRequest(
        'POST',
        'http://test/api/ai/generate',
        buildBody('overall'),
      ),
    );

    expect(res.status).toBe(201);
    const body = await getJson<AIInsight>(res);
    expect(body!.scope).toBe('overall');
  });
});
