/**
 * Shared API route helpers for OfficePilot.
 *
 * Every Next.js API route in this app follows the same skeleton:
 *
 *   1. Resolve the session (or 401).
 *   2. Authorize via `permissions.can(...)` (or 403).
 *   3. Validate the body / query (or 400).
 *   4. Run the business logic against Prisma.
 *   5. Translate any thrown error into a uniform JSON response.
 *
 * The helpers in this file factor those steps out so each route handler
 * stays narrow and focused on its actual logic. They are intentionally
 * I/O-thin (no DB, no Prisma) so unit tests can call them with plain
 * objects.
 *
 * Design notes:
 *   - All errors that travel through `errorResponse(...)` produce a JSON
 *     body shaped `{ error: string, ...details? }`. The string is short
 *     and stable so clients can switch on it; structured details (e.g.,
 *     Zod `issues`) live alongside it.
 *   - `UnauthorizedError` is a typed sentinel rather than a magic 401
 *     status, so the same shape works whether the route detected the
 *     missing session itself or got it from `requireSession()`.
 *   - Every helper that "throws on failure" pairs with a non-throwing
 *     `errorResponse(...)` so the route handler reduces to:
 *
 *       try {
 *         const session = await requireAdminSession();
 *         const body = await parseJsonBody(req, schema);
 *         // ...
 *       } catch (err) {
 *         return errorResponse(err);
 *       }
 *
 *   - Activity logging stays out of this file — the caller decides
 *     whether to log on success and is responsible for swallowing log
 *     failures so a missing audit row never tanks a successful write
 *     (SPEC.md §14).
 */

import { NextResponse } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';
import { Prisma } from '@prisma/client';

import { auth } from '@/lib/auth';
import {
  assertCan,
  PermissionError,
  type Action,
  type OwnedRecord,
  type PermissionSession,
  type Resource,
} from '@/lib/permissions';

// ---------------------------------------------------------------------------
// Session shape
// ---------------------------------------------------------------------------

/**
 * Concrete session shape after `requireSession()` succeeds.
 *
 * Mirrors the augmentation in `src/types/next-auth.d.ts` but pinned down
 * to non-optional `userId` and `role` so callers don't have to re-narrow
 * after the guard.
 */
export interface AuthenticatedSession {
  userId: string;
  role: 'ADMIN' | 'EMPLOYEE';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an API route is hit without a valid session.
 *
 * The middleware (see `src/middleware.ts`) already 401s unauthenticated
 * `/api/*` traffic, but route handlers still call `requireSession()`
 * defensively so a misconfigured matcher can't accidentally expose them.
 */
export class UnauthorizedError extends Error {
  readonly code = 'unauthorized' as const;

  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
    Object.setPrototypeOf(this, UnauthorizedError.prototype);
  }
}

/**
 * Thrown when JSON parsing fails or the schema rejects the body. Keeps
 * Zod errors first-class (kept on `.zodError`) so `errorResponse(...)`
 * can attach structured `issues` to the 400 payload.
 */
export class BadRequestError extends Error {
  readonly code = 'bad_request' as const;
  readonly zodError?: ZodError;

  constructor(message = 'Bad request', zodError?: ZodError) {
    super(message);
    this.name = 'BadRequestError';
    this.zodError = zodError;
    Object.setPrototypeOf(this, BadRequestError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Session guards
// ---------------------------------------------------------------------------

/**
 * Resolve the active NextAuth session and return its narrowed
 * {@link AuthenticatedSession} form. Throws {@link UnauthorizedError}
 * when no session is present (or when it lacks `userId`/`role`).
 *
 * Use at the top of every authenticated route handler:
 *
 *   const session = await requireSession();
 */
export async function requireSession(): Promise<AuthenticatedSession> {
  const session = await auth();
  if (!session || !session.userId || !session.role) {
    throw new UnauthorizedError();
  }
  return { userId: session.userId, role: session.role };
}

/**
 * Like {@link requireSession} but additionally requires `role === 'ADMIN'`.
 * Throws {@link PermissionError} (mapped to 403 by `errorResponse`) for
 * non-admin sessions.
 *
 * Use this at the top of admin-only handlers (e.g., `POST /api/users`):
 *
 *   const session = await requireAdminSession();
 */
export async function requireAdminSession(): Promise<AuthenticatedSession> {
  const session = await requireSession();
  if (session.role !== 'ADMIN') {
    // Re-use the canonical PermissionError so the 403 path is uniform
    // across "wrong role" and "doesn't own this record" failures.
    throw new PermissionError('admin', 'user');
  }
  return session;
}

/**
 * Thin wrapper around {@link assertCan} that takes our narrowed
 * {@link AuthenticatedSession}. Mostly here so route handlers don't have
 * to re-import `assertCan` from `permissions.ts` separately.
 */
export function assertCanOrThrow(
  session: PermissionSession,
  action: Action,
  resource: Resource,
  record?: OwnedRecord,
): void {
  assertCan(session, action, resource, record);
}

// ---------------------------------------------------------------------------
// Body / query parsing
// ---------------------------------------------------------------------------

/**
 * Read the request body as JSON and validate with the supplied Zod
 * schema. Throws {@link BadRequestError} for:
 *
 *   - Missing/invalid JSON (e.g. an empty POST body).
 *   - A schema validation failure (the `ZodError` is attached so the
 *     route can surface structured `issues`).
 *
 * Returns the parsed (and transformed — Zod runs its `.transform()` and
 * `.default()` chains here) value typed as the schema's `z.infer<...>`.
 */
export async function parseJsonBody<T>(
  req: Request,
  schema: ZodSchema<T>,
): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new BadRequestError('Invalid JSON body');
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestError('Validation failed', parsed.error);
  }
  return parsed.data;
}

/**
 * Validate URL search params against a Zod schema. The schema is
 * expected to use `z.coerce.*` / `.default()` for fields that come in
 * as strings — see `userListQuerySchema` in `src/lib/schemas/users.ts`
 * for the canonical example.
 *
 * When a key appears multiple times in the query string, the FIRST
 * value wins. Multi-value parameters are not part of the OfficePilot
 * API contract, so this is a deliberate simplification.
 */
export function parseSearchParams<T>(
  searchParams: URLSearchParams,
  schema: ZodSchema<T>,
): T {
  const obj: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    // First occurrence wins; duplicates are ignored. Routes that need
    // arrays should switch to a comma-separated convention and split in
    // the schema's `.transform(...)`.
    if (!(key in obj)) {
      obj[key] = value;
    }
  }

  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    throw new BadRequestError('Invalid query parameters', parsed.error);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Error response
// ---------------------------------------------------------------------------

/**
 * Map any error thrown in an API route to a uniform JSON `NextResponse`.
 *
 * Status mapping:
 *   • {@link UnauthorizedError}                  → 401 `{ error: 'unauthorized' }`
 *   • {@link PermissionError}                    → 403 `{ error: 'forbidden', action, resource }`
 *   • {@link BadRequestError} / {@link ZodError} → 400 `{ error: 'bad_request', issues? }`
 *   • Prisma `P2002` (unique constraint)         → 409 `{ error: 'conflict', target? }`
 *   • Prisma `P2025` (record not found)          → 404 `{ error: 'not_found' }`
 *   • Anything else                              → 500 `{ error: 'internal_error' }`
 *
 * Unknown errors are intentionally NOT echoed back to the client — they
 * may contain stack traces or PII. They go to `console.error` instead so
 * the server logs preserve them for debugging.
 */
export function errorResponse(error: unknown): NextResponse {
  if (error instanceof UnauthorizedError) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  if (error instanceof PermissionError) {
    return NextResponse.json(
      {
        error: 'forbidden',
        action: error.action,
        resource: error.resource,
      },
      { status: 403 },
    );
  }

  if (error instanceof BadRequestError) {
    return NextResponse.json(
      {
        error: 'bad_request',
        message: error.message,
        ...(error.zodError ? { issues: error.zodError.issues } : {}),
      },
      { status: 400 },
    );
  }

  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: 'bad_request', message: 'Validation failed', issues: error.issues },
      { status: 400 },
    );
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') {
      // `meta.target` is `string | string[] | undefined` depending on
      // the Prisma version; normalise to an array for clients.
      const target = error.meta?.target;
      const normalisedTarget = Array.isArray(target)
        ? target
        : typeof target === 'string'
          ? [target]
          : undefined;
      return NextResponse.json(
        {
          error: 'conflict',
          ...(normalisedTarget ? { target: normalisedTarget } : {}),
        },
        { status: 409 },
      );
    }
    if (error.code === 'P2025') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
  }

  // Don't leak internal details. Log server-side and return a generic
  // 500 so an unhandled bug surfaces in the dashboard but not in the
  // client console.
  // eslint-disable-next-line no-console
  console.error('[api] unhandled error', error);
  return NextResponse.json({ error: 'internal_error' }, { status: 500 });
}
