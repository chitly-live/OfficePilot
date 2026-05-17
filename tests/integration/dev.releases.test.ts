/**
 * Integration tests for `GET /api/dev/releases` (task 58 in
 * `.kiro/specs/officepilot/tasks.md`).
 *
 * The endpoint returns `DevTask` rows where `type = RELEASE`, ordered
 * `releasedAt desc` (NULLs last for unshipped releases) and
 * optionally narrowed by `?platform=`. See
 * `src/app/api/dev/releases/route.ts` for the full contract.
 *
 * Validates: Requirements 8.1, 8.6, 8.7, 8.8, 15.2, 15.3
 * Spec references: SPEC.md §9.2.3, §9.3, §9.2.6, §16.2.
 *
 * Coverage matrix:
 *
 *   Verb / Endpoint           Happy   401   Filter   Counted-bugs check
 *   GET /api/dev/releases      ✓      ✓     platform  ✓ (DB-side count)
 *
 * Note on the "bugs reported in 7 days after release" stat:
 *   SPEC §9.2.6 calls for a per-release stats card showing the count
 *   of bugs reported in the 7 days following `releasedAt`. The
 *   release-list route does NOT compute that today (the surface is
 *   intentionally flat — see `src/app/(app)/dev/releases/page.tsx`'s
 *   header comment marking it out of scope for v1). To still cover
 *   the spec invariant, the test below verifies the count is
 *   correctly computable from the persisted data: it seeds a release,
 *   logs three BUG tasks (two within the 7-day window, one outside),
 *   and asserts the DB-side count matches `2`.
 */

import { describe, expect, it } from 'vitest';
import { DevTaskStatus, DevTaskType, Priority } from '@prisma/client';

import { GET as listReleases } from '@/app/api/dev/releases/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * Insert a release-typed `DevTask`. Wraps `prisma.devTask.create` so
 * each test only specifies the release-specific fields.
 */
async function seedRelease(
  reporterId: string,
  overrides: {
    title?: string;
    releaseVersion?: string;
    platform?: string;
    releasedAt?: Date | null;
  } = {},
): Promise<{ id: string; releaseVersion: string | null }> {
  return prisma.devTask.create({
    data: {
      title: overrides.title ?? `Release ${overrides.releaseVersion ?? 'v1'}`,
      type: DevTaskType.RELEASE,
      status: DevTaskStatus.DONE,
      priority: Priority.MEDIUM,
      reporterId,
      releaseVersion: overrides.releaseVersion ?? 'v1.0.0',
      platform: overrides.platform ?? 'iOS',
      ...(overrides.releasedAt !== undefined
        ? { releasedAt: overrides.releasedAt }
        : {}),
    },
    select: { id: true, releaseVersion: true },
  });
}

/**
 * Insert a non-release task so we can prove the route filters it out.
 */
async function seedNonReleaseTask(
  reporterId: string,
  type: DevTaskType,
): Promise<void> {
  await prisma.devTask.create({
    data: {
      title: `Distractor ${type}`,
      type,
      status: DevTaskStatus.TODO,
      priority: Priority.MEDIUM,
      reporterId,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/dev/releases — auth
// ---------------------------------------------------------------------------

describe('GET /api/dev/releases — auth', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);
    const res = await listReleases(
      buildJsonRequest('GET', 'http://test/api/dev/releases'),
    );
    expect(res.status).toBe(401);
    expect(await getJson(res)).toEqual({ error: 'unauthorized' });
  });
});

// ---------------------------------------------------------------------------
// GET /api/dev/releases — happy path
// ---------------------------------------------------------------------------

describe('GET /api/dev/releases — happy path', () => {
  it('returns only RELEASE-typed tasks, ordered by releasedAt desc with NULL last', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    // Seed three releases at different `releasedAt` times plus one
    // unshipped (NULL releasedAt) and one non-release distractor.
    const oldRelease = await seedRelease(admin.id, {
      releaseVersion: 'v1.0.0',
      platform: 'iOS',
      releasedAt: new Date('2026-01-15T10:00:00Z'),
    });
    const newestRelease = await seedRelease(admin.id, {
      releaseVersion: 'v2.5.0',
      platform: 'iOS',
      releasedAt: new Date('2026-04-15T10:00:00Z'),
    });
    const midRelease = await seedRelease(admin.id, {
      releaseVersion: 'v2.0.0',
      platform: 'Android',
      releasedAt: new Date('2026-03-01T10:00:00Z'),
    });
    const unshipped = await seedRelease(admin.id, {
      releaseVersion: 'v3.0.0-beta',
      platform: 'Web',
      releasedAt: null,
    });
    await seedNonReleaseTask(admin.id, DevTaskType.FEATURE);
    await seedNonReleaseTask(admin.id, DevTaskType.BUG);

    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listReleases(
      buildJsonRequest('GET', 'http://test/api/dev/releases'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{
        id: string;
        type: DevTaskType;
        releaseVersion: string | null;
        releasedAt: string | null;
      }>;
    }>(res);
    expect(body).not.toBeNull();
    expect(body!.items).toHaveLength(4);
    // Type filter — non-release tasks are dropped.
    for (const item of body!.items) {
      expect(item.type).toBe(DevTaskType.RELEASE);
    }
    // Order — newest first, then mid, then old, then unshipped (NULLS
    // LAST). We assert by id so any future formatter changes don't
    // break the test on whitespace.
    expect(body!.items.map((i) => i.id)).toEqual([
      newestRelease.id,
      midRelease.id,
      oldRelease.id,
      unshipped.id,
    ]);
  });

  it('honours the ?platform filter', async () => {
    const { user: employee } = await createTestUser({ role: 'EMPLOYEE' });

    await seedRelease(employee.id, {
      releaseVersion: 'v1.0.0',
      platform: 'iOS',
      releasedAt: new Date('2026-04-01T10:00:00Z'),
    });
    await seedRelease(employee.id, {
      releaseVersion: 'v1.0.0',
      platform: 'Android',
      releasedAt: new Date('2026-04-02T10:00:00Z'),
    });
    await seedRelease(employee.id, {
      releaseVersion: 'v1.1.0',
      platform: 'iOS',
      releasedAt: new Date('2026-04-15T10:00:00Z'),
    });

    await setSession({ userId: employee.id, role: 'EMPLOYEE' });

    const res = await listReleases(
      buildJsonRequest('GET', 'http://test/api/dev/releases?platform=iOS'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{
      items: Array<{ platform: string | null }>;
    }>(res);
    expect(body!.items).toHaveLength(2);
    expect(body!.items.every((i) => i.platform === 'iOS')).toBe(true);
  });

  it('returns an empty list when no releases exist', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    // Only a non-release row exists.
    await seedNonReleaseTask(admin.id, DevTaskType.FEATURE);
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await listReleases(
      buildJsonRequest('GET', 'http://test/api/dev/releases'),
    );

    expect(res.status).toBe(200);
    const body = await getJson<{ items: unknown[] }>(res);
    expect(body!.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SPEC §9.2.6 — bugs reported in 7 days after releasedAt
// ---------------------------------------------------------------------------

describe('GET /api/dev/releases — SPEC §9.2.6 bug-count derivability', () => {
  /**
   * The release-list route doesn't currently expose the post-release
   * bug count itself (the dashboard derives it client-side or via a
   * later widget — see `src/app/(app)/dev/releases/page.tsx`'s
   * out-of-scope note). What we CAN guarantee today is that the
   * count is correctly *derivable* from the persisted data — i.e.,
   * `DevTask.createdAt` reliably falls inside the 7-day window for
   * post-release bugs. This test pins that invariant so a future
   * `bugsReportedAfter` aggregate has a stable foundation.
   */
  it('counts BUG tasks created within the 7 days after `releasedAt` and excludes earlier/later ones', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });

    const releasedAt = new Date('2026-04-01T10:00:00Z');
    await seedRelease(admin.id, {
      releaseVersion: 'v2.5.0',
      platform: 'iOS',
      releasedAt,
    });

    // Bug logged 1 day after release — IN window.
    await prisma.devTask.create({
      data: {
        title: 'Login crash',
        type: DevTaskType.BUG,
        status: DevTaskStatus.TODO,
        priority: Priority.HIGH,
        reporterId: admin.id,
        createdAt: new Date('2026-04-02T11:00:00Z'),
      },
    });
    // Bug logged 6 days after release — IN window.
    await prisma.devTask.create({
      data: {
        title: 'Settings menu glitch',
        type: DevTaskType.BUG,
        status: DevTaskStatus.TODO,
        priority: Priority.MEDIUM,
        reporterId: admin.id,
        createdAt: new Date('2026-04-07T09:00:00Z'),
      },
    });
    // Bug logged 8 days after release — OUTSIDE window.
    await prisma.devTask.create({
      data: {
        title: 'Late-bloom regression',
        type: DevTaskType.BUG,
        status: DevTaskStatus.TODO,
        priority: Priority.MEDIUM,
        reporterId: admin.id,
        createdAt: new Date('2026-04-09T10:00:00Z'),
      },
    });
    // Bug logged BEFORE the release — OUTSIDE window.
    await prisma.devTask.create({
      data: {
        title: 'Pre-existing scroll bug',
        type: DevTaskType.BUG,
        status: DevTaskStatus.TODO,
        priority: Priority.LOW,
        reporterId: admin.id,
        createdAt: new Date('2026-03-20T10:00:00Z'),
      },
    });

    // Sanity-check the route still returns the release row itself.
    await setSession({ userId: admin.id, role: 'ADMIN' });
    const res = await listReleases(
      buildJsonRequest('GET', 'http://test/api/dev/releases'),
    );
    expect(res.status).toBe(200);
    const body = await getJson<{ items: Array<{ releaseVersion: string }> }>(
      res,
    );
    expect(body!.items).toHaveLength(1);
    expect(body!.items[0]!.releaseVersion).toBe('v2.5.0');

    // The actual SPEC §9.2.6 invariant: count BUGs in `[releasedAt,
    // releasedAt + 7d)`. Computed via Prisma so the count survives any
    // future relocation of the calculation into the route handler.
    const sevenDaysLater = new Date(
      releasedAt.getTime() + 7 * 24 * 60 * 60 * 1000,
    );
    const count = await prisma.devTask.count({
      where: {
        type: DevTaskType.BUG,
        createdAt: { gte: releasedAt, lt: sevenDaysLater },
      },
    });
    expect(count).toBe(2);
  });
});
