/**
 * Role-based middleware for OfficePilot.
 *
 * Implements SPEC.md §2.2 (Auth flow), §2.1 (Roles), and the role
 * gating rules in design.md "Roles, Auth, and Permissions". Sits in
 * front of every request matched by `config.matcher` below and:
 *
 *   1. Lets PUBLIC routes through unconditionally — login page, the
 *      Auth.js endpoints themselves, the HMAC-verified inbound lead
 *      webhook, and bearer-token-protected cron endpoints. These
 *      routes do their own auth and MUST NOT be cookie-gated.
 *   2. Forces UNAUTHENTICATED requests to either `/login?callbackUrl=`
 *      (page navigations) or a bare `401 Unauthorized` JSON body
 *      (`/api/*` calls).
 *   3. Enforces ADMIN-only access on the small surface of admin-only
 *      pages and APIs — see `ADMIN_ONLY_PATTERNS` below — by reading
 *      `req.auth.role` from the verified JWT.
 *
 * Runtime: Next.js middleware ALWAYS runs on the Edge. We deliberately
 * import from `@/lib/auth-edge` (a trimmed Auth.js config with no
 * providers, no DB) instead of `@/lib/auth`, which pulls in Prisma and
 * bcryptjs and is not Edge-safe. Both configs share the same
 * `NEXTAUTH_SECRET`, so JWTs minted by the Node-side Credentials sign-in
 * flow round-trip cleanly here.
 *
 * The `config.matcher` below excludes the static-asset surface so we
 * don't pay a JWT-verify cost on every `/_next/static/...` chunk.
 */

import { NextResponse } from 'next/server';

import { auth } from '@/lib/auth-edge';
import {
  MODULE_API_PREFIXES,
  MODULE_PREFIXES,
  canAccessModule,
} from '@/lib/permissions';

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/**
 * Routes that MUST be reachable without a session cookie.
 *
 *   • `/login` — entry point for unauthenticated users.
 *   • `/api/auth/*` — Auth.js's own sign-in / sign-out / csrf / session
 *     endpoints; gating these breaks the login flow itself.
 *   • `/api/webhooks/*` — public, HMAC-verified inbound integrations
 *     (SPEC.md §6.2.8).
 *   • `/api/cron/*` — bearer-token-protected scheduler endpoints
 *     (SPEC.md §10.6).
 *
 * Each entry is a prefix match; `/login` matches `/login` AND
 * `/login/anything`, which is intentional in case auth sub-routes are
 * added later (e.g., `/login/forgot`).
 */
const PUBLIC_PATH_PREFIXES = [
  '/login',
  // Self-service password reset pages. Their APIs live under `/api/auth`.
  '/forgot-password',
  '/reset-password',
  '/api/auth',
  '/api/webhooks',
  '/api/cron',
] as const;

/**
 * ADMIN-only routes. Authenticated EMPLOYEEs hitting these are denied
 * (403 for APIs, redirect to `/dashboard` for pages).
 *
 *   • `/settings/users`, `/api/settings` — user management & sensitive
 *     settings (SPEC.md §12, "admin only for sensitive fields").
 *   • `/ai`, `/api/ai/usage` — AI insight feed and Claude spend visibility
 *     (SPEC.md §10.5; §11.5 role gating).
 *
 * `/api/users` is intentionally NOT prefix-gated here even though the
 * collection endpoints (`GET`/`POST /api/users`) and `DELETE /api/users/[id]`
 * are admin-only — per SPEC.md §5.3, employees can `GET`/`PATCH` their
 * own profile via `/api/users/[id]`. The route handlers do their own
 * `requireAdminSession()` (or self-vs-admin) check so a middleware-level
 * block here would over-restrict and break self-edit.
 */
const ADMIN_ONLY_PATH_PREFIXES = [
  '/settings/users',
  '/api/settings',
  '/ai',
  '/api/ai/usage',
  // Finance module (v0.1.5) — money ledger is admin-only for now.
  '/finance',
  '/api/finance',
] as const;

function hasPrefix(pathname: string, prefixes: readonly string[]): boolean {
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  return false;
}

/** Single-prefix variant — used by the module gate, which matches on
 *  one prefix per moduleId rather than a flat array. */
function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function jsonError(status: number, message: string): NextResponse {
  return new NextResponse(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export default auth((req) => {
  const { nextUrl } = req;
  const pathname = nextUrl.pathname;

  // 1. Public routes always pass through. They handle their own auth
  //    (HMAC, bearer token, or "no auth needed" for the login page).
  if (hasPrefix(pathname, PUBLIC_PATH_PREFIXES)) {
    return NextResponse.next();
  }

  const session = req.auth;
  const isAuthenticated = Boolean(session?.userId);

  // 2. Unauthenticated → 401 for APIs, redirect to /login for pages.
  if (!isAuthenticated) {
    if (isApiPath(pathname)) {
      return jsonError(401, 'Unauthorized');
    }
    const loginUrl = new URL('/login', nextUrl.origin);
    // Preserve where the user was trying to go so post-login can bounce
    // them back. NextAuth's signIn redirect picks this up automatically
    // when the form posts callbackUrl.
    loginUrl.searchParams.set('callbackUrl', `${pathname}${nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  // 3. Admin-only gate. EMPLOYEEs get 403 (APIs) or a soft redirect to
  //    /dashboard (pages) — never a hard 404 — so navigation feels
  //    forgiving even if they bookmarked an admin URL.
  if (hasPrefix(pathname, ADMIN_ONLY_PATH_PREFIXES) && session?.role !== 'ADMIN') {
    if (isApiPath(pathname)) {
      return jsonError(403, 'Forbidden');
    }
    return NextResponse.redirect(new URL('/dashboard', nextUrl.origin));
  }

  // 4. Per-module access gate for EMPLOYEE users.
  //    ADMINs short-circuit inside `canAccessModule`, and legacy
  //    employees with an empty `moduleAccess` array do the same (see
  //    `src/lib/permissions.ts#canAccessModule`). Page hits redirect to
  //    `/dashboard`; API hits return a structured 403 JSON body that
  //    clients can branch on.
  if (session?.role === 'EMPLOYEE' && session.moduleAccess) {
    const user = {
      role: session.role,
      moduleAccess: session.moduleAccess,
    };

    // Page-route check first. Each moduleId owns a single prefix; we
    // break out of the loop as soon as we find the owning module.
    for (const [moduleId, prefix] of MODULE_PREFIXES) {
      if (matchesPrefix(pathname, prefix)) {
        if (!canAccessModule(user, moduleId)) {
          if (isApiPath(pathname)) {
            // Defensive: a path under MODULE_PREFIXES that also begins
            // with `/api/` shouldn't exist today, but if a future route
            // collision happens, surface a structured 403 instead of a
            // user-visible redirect.
            return NextResponse.json(
              { error: 'module_access_denied', module: moduleId },
              { status: 403 },
            );
          }
          return NextResponse.redirect(new URL('/dashboard', nextUrl.origin));
        }
        break;
      }
    }

    // API-route check.
    for (const [moduleId, prefix] of MODULE_API_PREFIXES) {
      if (matchesPrefix(pathname, prefix)) {
        if (!canAccessModule(user, moduleId)) {
          return NextResponse.json(
            { error: 'module_access_denied', module: moduleId },
            { status: 403 },
          );
        }
        break;
      }
    }
  }

  return NextResponse.next();
});

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/**
 * Run the middleware on every request EXCEPT:
 *   • `/_next/static/*`, `/_next/image/*` — build artefacts.
 *   • `/favicon.ico` — browser-issued and harmless.
 *   • Common static asset extensions (svg, png, jpg, jpeg, gif, webp).
 *
 * Everything else — pages, API routes, and any unknown path — flows
 * through this file. Public routes are filtered inside the handler so
 * we keep the matcher syntactically simple.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
