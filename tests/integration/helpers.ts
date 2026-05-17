/**
 * Shared helpers for integration tests (task 29).
 *
 * Surface area kept deliberately small:
 *
 *   • `setSession(session)` — arm the mocked `auth()` to resolve to the
 *     given session (or null) for the next call(s).
 *   • `createTestUser(overrides?)` — insert a `User` row with bcrypt
 *     password and return the row + its plaintext credentials.
 *   • `buildJsonRequest(method, url, body?)` — produce a `NextRequest`
 *     suitable for invoking a Next.js App Router handler directly. We
 *     construct a plain `Request` and cast to `NextRequest` because the
 *     handlers only ever read `.json()`, `.nextUrl.searchParams`, and
 *     `.url`.
 *   • `getJson(response)` — parse a `NextResponse`'s JSON body,
 *     swallowing the empty-body case for 204 responses.
 *
 * All helpers depend on the mock established in `tests/integration/setup.ts`
 * and assume the test DB env var has already been stamped.
 */

import { hash } from 'bcryptjs';
import { type NextRequest } from 'next/server';
import { type Mock, vi } from 'vitest';
import type { Role, User } from '@prisma/client';

import { prisma } from '@/lib/db';

// ---------------------------------------------------------------------------
// Session control
// ---------------------------------------------------------------------------

/**
 * Shape of the session object the route handlers expect. Mirrors the
 * augmentation in `src/types/next-auth.d.ts` but only the fields the
 * route handlers actually read.
 */
export interface FakeSession {
  userId: string;
  role: Role;
  user?: { id: string; role: Role; name?: string; email?: string };
}

/**
 * Re-arm the mocked `auth()` so the next call resolves to `session`.
 * Pass `null` to simulate the "no session" 401 case.
 *
 * Implementation note: we re-import the mocked module and grab the
 * `auth` mock fresh each time. This keeps the helper resilient to
 * Vitest's per-file module-graph reloads.
 */
export async function setSession(session: FakeSession | null): Promise<void> {
  const authModule = await import('@/lib/auth');
  const authMock = authModule.auth as unknown as Mock;
  if (session === null) {
    authMock.mockResolvedValue(null);
    return;
  }
  // Provide both the top-level `userId`/`role` (read by `requireSession`)
  // and the nested `user.id`/`user.role` (read by some legacy paths).
  authMock.mockResolvedValue({
    userId: session.userId,
    role: session.role,
    user: session.user ?? {
      id: session.userId,
      role: session.role,
      name: 'Test User',
      email: 'test@example.com',
    },
  });
}

// ---------------------------------------------------------------------------
// Fixture: User
// ---------------------------------------------------------------------------

/**
 * Counter for unique-email generation across tests in the same file.
 * Reset per `beforeEach` truncate is unnecessary — Postgres unique
 * constraints are on the row, and this just ensures we don't collide
 * within a single test.
 */
let userSeq = 0;

export interface CreateTestUserOptions {
  role?: Role;
  email?: string;
  name?: string;
  password?: string;
  isActive?: boolean;
}

export interface CreatedTestUser {
  user: User;
  password: string;
}

/**
 * Insert a `User` row with a bcrypt-hashed password. Returns both the
 * Prisma row and the plaintext password (for tests that need to call
 * authenticated endpoints with the user's credentials).
 *
 * Defaults:
 *   • role     = `'EMPLOYEE'`
 *   • email    = `user-${seq}-${ts}@test.local` (always unique)
 *   • password = `'TestPass123!'`
 *   • isActive = `true`
 */
export async function createTestUser(
  options: CreateTestUserOptions = {},
): Promise<CreatedTestUser> {
  userSeq += 1;
  const password = options.password ?? 'TestPass123!';
  const passwordHash = await hash(password, 4); // cost 4 keeps tests fast.
  const email = options.email ?? `user-${userSeq}-${Date.now()}@test.local`;
  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      name: options.name ?? `Test User ${userSeq}`,
      role: options.role ?? ('EMPLOYEE' as Role),
      isActive: options.isActive ?? true,
    },
  });
  return { user, password };
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/**
 * Build a `NextRequest`-compatible object for a route handler.
 *
 * Next.js's App Router handlers receive a `NextRequest` whose only
 * non-standard surface (vs the Web `Request`) is `nextUrl`. The
 * `next/server` runtime wraps a `Request` to expose this property —
 * we construct it manually here because importing `NextRequest`
 * directly under Vitest's Node environment hits internal Next.js
 * dependencies. The cast is safe in practice: every users-endpoint
 * handler only reads `.json()`, `.nextUrl.searchParams`, and `.url`.
 */
export function buildJsonRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
): NextRequest {
  const init: RequestInit = {
    method,
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const req = new Request(url, init) as Request & {
    nextUrl: URL;
  };
  // Lazily expose `nextUrl` so handlers reading `req.nextUrl.searchParams`
  // see a parsed URL. Mirrors what Next.js's runtime would have built.
  Object.defineProperty(req, 'nextUrl', {
    get() {
      return new URL(url);
    },
  });
  return req as NextRequest;
}

/**
 * Build a `RouteContext` object compatible with the dynamic-segment
 * handlers under `/api/users/[id]/...`. Saves typing the same shape in
 * every test.
 */
export function buildRouteContext(id: string): { params: { id: string } } {
  return { params: { id } };
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `NextResponse`'s JSON body. Returns `null` for 204/empty
 * responses so callers can `expect(body).toBeNull()` without try/catch.
 */
export async function getJson<T = unknown>(
  response: Response,
): Promise<T | null> {
  if (response.status === 204) return null;
  // Some 4xx responses with no body still claim JSON content-type —
  // tolerate empty strings rather than crashing on `.json()`.
  const text = await response.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as T;
}

// Convenience re-export so test files don't have to import vi just to
// reach into the mock for one-off assertions.
export { vi };
