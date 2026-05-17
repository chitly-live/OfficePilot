/**
 * Integration tests for the social-posts collection + detail endpoints
 * (Wave 5 — SPEC.md §8.3).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 15.2, 15.3
 * Spec references: SPEC.md §8.2, §8.3, §16.2.
 *
 * Coverage matrix per SPEC §16.2 (happy / 401 / 403 / 400):
 *
 *   Verb / Endpoint                     Happy   401   403                     400
 *   GET    /api/social/posts              ✓      ✓     —                       —
 *   POST   /api/social/posts              ✓      ✓     ✓ (employee assigning   ✓
 *                                                       to other user)
 *   PATCH  /api/social/posts/[id]         ✓      ✓     ✓ (employee editing     ✓
 *                                                       another user's post)
 *
 * Per-endpoint specifics relevant to the activity log:
 *   • POST writes `socialpost.created`.
 *   • PATCH that flips status NON-PUBLISHED → PUBLISHED writes
 *     `socialpost.published` AND auto-stamps `publishedAt = now()`.
 *   • PATCH that toggles `isWinner` writes `socialpost.winner_marked`
 *     (the prompt's "winner-marking activity log" coverage point).
 *
 * Tests construct a `Request` directly and invoke the route handler
 * function — no spinning up a Next server. Per-test DB cleanup happens
 * in `tests/integration/setup.ts`'s `beforeEach(truncateAll)`.
 */

import { describe, expect, it } from 'vitest';
import { PostStatus, SocialPlatform } from '@prisma/client';

import { GET as listPosts, POST as createPost } from '@/app/api/social/posts/route';
import { PATCH as patchPost } from '@/app/api/social/posts/[id]/route';
import { prisma } from '@/lib/db';

import {
  buildJsonRequest,
  buildRouteContext,
  createTestUser,
  getJson,
  setSession,
} from './helpers';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

interface SeedPostOverrides {
  ownerId: string;
  caption?: string;
  platform?: SocialPlatform;
  status?: PostStatus;
  isWinner?: boolean;
  publishedAt?: Date | null;
  scheduledAt?: Date | null;
}

/**
 * Insert a `SocialPost` row directly via Prisma. `ownerId` is required
 * because `SocialPost.ownerId` is non-nullable.
 */
async function seedPost(overrides: SeedPostOverrides): Promise<{
  id: string;
  ownerId: string;
  status: PostStatus;
  isWinner: boolean;
  publishedAt: Date | null;
}> {
  return prisma.socialPost.create({
    data: {
      caption: overrides.caption ?? 'Sample caption',
      platform: overrides.platform ?? SocialPlatform.INSTAGRAM,
      status: overrides.status ?? PostStatus.DRAFT,
      mediaUrls: [],
      hashtags: [],
      isWinner: overrides.isWinner ?? false,
      ownerId: overrides.ownerId,
      ...(overrides.publishedAt !== undefined
        ? { publishedAt: overrides.publishedAt }
        : {}),
      ...(overrides.scheduledAt !== undefined
        ? { scheduledAt: overrides.scheduledAt }
        : {}),
    },
    select: {
      id: true,
      ownerId: true,
      status: true,
      isWinner: true,
      publishedAt: true,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/social/posts
// ---------------------------------------------------------------------------

describe('GET /api/social/posts', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await listPosts(
      buildJsonRequest('GET', 'http://test/api/social/posts'),
    );
    expect(res.status).toBe(401);
  });

  it('returns the global list of posts to any authenticated user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: bob } = await createTestUser({ role: 'EMPLOYEE' });

    await seedPost({ ownerId: alice.id, caption: 'Alice draft' });
    await seedPost({ ownerId: bob.id, caption: 'Bob draft' });
    await seedPost({ ownerId: admin.id, caption: 'Admin draft' });

    // Bob (EMPLOYEE) sees every post — social is a shared workspace.
    await setSession({ userId: bob.id, role: 'EMPLOYEE' });

    const res = await listPosts(
      buildJsonRequest('GET', 'http://test/api/social/posts'),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{
      items: Array<{ caption: string }>;
      total: number;
    }>(res);
    expect(body!.total).toBe(3);
    expect(body!.items.map((p) => p.caption).sort()).toEqual([
      'Admin draft',
      'Alice draft',
      'Bob draft',
    ]);
  });
});

// ---------------------------------------------------------------------------
// POST /api/social/posts
// ---------------------------------------------------------------------------

describe('POST /api/social/posts — auth and validation', () => {
  it('returns 401 when no session is present', async () => {
    await setSession(null);

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.INSTAGRAM,
        caption: 'Hello world',
      }),
    );
    expect(res.status).toBe(401);
  });

  it('returns 400 when caption is missing (zod failure)', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.INSTAGRAM,
        // no caption
      }),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });

  it('returns 400 when status=SCHEDULED is set without a scheduledAt', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.INSTAGRAM,
        caption: 'Will be scheduled',
        status: PostStatus.SCHEDULED,
        // missing scheduledAt
      }),
    );
    expect(res.status).toBe(400);
  });

  it('returns 403 when an EMPLOYEE assigns a new post to another user', async () => {
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: bob } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: alice.id, role: 'EMPLOYEE' });

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.INSTAGRAM,
        caption: 'Hijack assignment',
        ownerId: bob.id,
      }),
    );
    expect(res.status).toBe(403);

    // No row was created.
    const count = await prisma.socialPost.count();
    expect(count).toBe(0);
  });
});

describe('POST /api/social/posts — happy path', () => {
  it('creates a draft post owned by the caller and writes `socialpost.created`', async () => {
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: alice.id, role: 'EMPLOYEE' });

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.INSTAGRAM,
        caption: 'Fresh draft from Alice',
        hashtags: ['chitly', 'launch'],
      }),
    );
    expect(res.status).toBe(201);

    const body = await getJson<{
      id: string;
      ownerId: string;
      status: PostStatus;
      caption: string;
      hashtags: string[];
    }>(res);
    expect(body!.ownerId).toBe(alice.id);
    expect(body!.status).toBe(PostStatus.DRAFT);
    expect(body!.caption).toBe('Fresh draft from Alice');
    expect(body!.hashtags).toEqual(['chitly', 'launch']);

    // Activity log row written.
    const log = await prisma.activityLog.findFirst({
      where: {
        userId: alice.id,
        action: 'socialpost.created',
        entityType: 'socialpost',
        entityId: body!.id,
      },
    });
    expect(log).not.toBeNull();
  });

  it('admin can assign a new post to any user', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await createPost(
      buildJsonRequest('POST', 'http://test/api/social/posts', {
        platform: SocialPlatform.LINKEDIN,
        caption: 'Admin-assigned to Alice',
        ownerId: alice.id,
      }),
    );
    expect(res.status).toBe(201);

    const body = await getJson<{ id: string; ownerId: string }>(res);
    expect(body!.ownerId).toBe(alice.id);
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/social/posts/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/social/posts/[id] — auth', () => {
  it('returns 401 when no session is present', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const post = await seedPost({ ownerId: admin.id });
    await setSession(null);

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {
        caption: 'Hijacked',
      }),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(401);
  });

  it('returns 403 when an EMPLOYEE patches a post they do not own', async () => {
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const { user: bob } = await createTestUser({ role: 'EMPLOYEE' });
    const post = await seedPost({ ownerId: alice.id, caption: 'Alice post' });
    await setSession({ userId: bob.id, role: 'EMPLOYEE' });

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {
        caption: 'Hijacked by Bob',
      }),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(403);

    const stored = await prisma.socialPost.findUnique({ where: { id: post.id } });
    expect(stored!.caption).toBe('Alice post');
  });

  it('admin can update any post regardless of ownership', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const { user: alice } = await createTestUser({ role: 'EMPLOYEE' });
    const post = await seedPost({ ownerId: alice.id, caption: 'Original' });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {
        caption: 'Admin-edited',
      }),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ caption: string }>(res);
    expect(body!.caption).toBe('Admin-edited');
  });
});

describe('PATCH /api/social/posts/[id] — validation', () => {
  it('returns 400 on an empty PATCH body', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const post = await seedPost({ ownerId: admin.id });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {}),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(400);
    const body = await getJson<{ error: string }>(res);
    expect(body!.error).toBe('bad_request');
  });
});

describe('PATCH /api/social/posts/[id] — activity logging', () => {
  it('writes `socialpost.winner_marked` when isWinner toggles to true', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const post = await seedPost({
      ownerId: admin.id,
      caption: 'Soon to win',
      isWinner: false,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {
        isWinner: true,
      }),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ isWinner: boolean }>(res);
    expect(body!.isWinner).toBe(true);

    const log = await prisma.activityLog.findFirst({
      where: {
        userId: admin.id,
        action: 'socialpost.winner_marked',
        entityType: 'socialpost',
        entityId: post.id,
      },
    });
    expect(log).not.toBeNull();
    expect(log!.metadata).toMatchObject({ isWinner: true });

    // No generic `socialpost.updated` row should be written when a
    // dedicated event already covers the change.
    const generic = await prisma.activityLog.findMany({
      where: { action: 'socialpost.updated', entityId: post.id },
    });
    expect(generic).toHaveLength(0);
  });

  it('writes `socialpost.published` and stamps publishedAt on first transition to PUBLISHED', async () => {
    const { user: admin } = await createTestUser({ role: 'ADMIN' });
    const post = await seedPost({
      ownerId: admin.id,
      caption: 'Soon to publish',
      status: PostStatus.DRAFT,
      publishedAt: null,
    });
    await setSession({ userId: admin.id, role: 'ADMIN' });

    const res = await patchPost(
      buildJsonRequest('PATCH', `http://test/api/social/posts/${post.id}`, {
        status: PostStatus.PUBLISHED,
      }),
      buildRouteContext(post.id),
    );
    expect(res.status).toBe(200);

    const body = await getJson<{ status: PostStatus; publishedAt: string | null }>(
      res,
    );
    expect(body!.status).toBe(PostStatus.PUBLISHED);
    expect(body!.publishedAt).not.toBeNull();

    const stored = await prisma.socialPost.findUnique({ where: { id: post.id } });
    expect(stored!.publishedAt).not.toBeNull();

    const log = await prisma.activityLog.findFirst({
      where: {
        action: 'socialpost.published',
        entityType: 'socialpost',
        entityId: post.id,
      },
    });
    expect(log).not.toBeNull();
  });
});
