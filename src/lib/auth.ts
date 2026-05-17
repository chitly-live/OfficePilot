/**
 * NextAuth (Auth.js v5) configuration for OfficePilot.
 *
 * Implements the auth flow described in SPEC.md §2.2 and design.md
 * "Roles, Auth, and Permissions":
 *
 *   • Credentials provider (email + password) — no public signup, no
 *     OAuth providers, no magic links.
 *   • Bcrypt verification at cost 12 against `User.passwordHash`.
 *   • Deactivated users (`isActive === false`) are rejected outright at
 *     sign-in AND re-checked on a 5-minute cadence during the lifetime
 *     of an existing session (see the `jwt` callback below — panel-audit gap
 *     B4 (v0.1.2)). A user deactivated via `DELETE /api/users/[id]` loses access
 *     within ~5 minutes max without needing to wait for JWT expiry.
 *   • JWT session strategy with a 7-day sliding renewal window
 *     (NextAuth refreshes the cookie on every request by default).
 *   • Session and JWT carry `userId` and `role` so `permissions.can(...)`
 *     can run without a second DB lookup. See `src/types/next-auth.d.ts`
 *     for the type augmentation.
 *
 * Exports the standard Auth.js v5 quartet — `auth`, `signIn`, `signOut`,
 * `handlers` — wired up by:
 *   • `src/app/api/auth/[...nextauth]/route.ts` (task 17)
 *   • `src/middleware.ts` (task 18)
 *   • Route handlers across the app (waves 2–7) calling `await auth()`.
 *
 * NOTE: import from `next-auth` (the v5 entry), NOT `next-auth/next`
 * (which only exists in v4).
 */

import NextAuth, { CredentialsSignin, type NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { compare } from 'bcryptjs';
import { z } from 'zod';

import { prisma } from '@/lib/db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7-day session lifetime per SPEC.md §2.2. NextAuth treats this as both
 *  the JWT `exp` and the cookie max-age, and refreshes both on every
 *  authenticated request (sliding renewal). */
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long the `jwt` callback trusts a previously-validated `isActive`
 * flag before re-querying Postgres. Five minutes is the security-vs-cost
 * sweet spot: short enough that a deactivated user loses access "soon
 * after" the admin clicks Deactivate (worst-case latency: ~5 minutes),
 * long enough that we avoid hammering the DB on every authenticated
 * request. See the `jwt` callback below for the design rationale.
 */
const ISACTIVE_RECHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Validates the `credentials` payload coming from the login form. The
 *  Credentials provider also enforces this implicitly via its own
 *  `credentials` field, but we re-validate at runtime so a malformed
 *  body short-circuits before we touch the database. */
const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Custom error
// ---------------------------------------------------------------------------

/**
 * Thrown from `authorize()` when login fails. Returning `null` would also
 * work, but `CredentialsSignin` lets the login page distinguish auth
 * failures from server errors via `error.code`. The same generic message
 * is surfaced for "user not found", "wrong password", and "deactivated"
 * to avoid user-enumeration leaks (SPEC.md §12.4).
 */
class InvalidCredentialsError extends CredentialsSignin {
  code = 'invalid_credentials';
}

// ---------------------------------------------------------------------------
// NextAuth config
// ---------------------------------------------------------------------------

export const authConfig: NextAuthConfig = {
  // NEXTAUTH_SECRET is auto-detected by Auth.js v5 from process.env, but
  // we wire it explicitly so the contract is visible at the call site.
  secret: process.env.NEXTAUTH_SECRET,

  session: {
    strategy: 'jwt',
    maxAge: SEVEN_DAYS_IN_SECONDS,
    // Refresh the JWT every time it's used so the 7-day window slides
    // forward on activity. `0` means "always update on every request".
    updateAge: 0,
  },

  pages: {
    // Custom login page rendered in `src/app/(auth)/login/page.tsx`
    // (task 19). NextAuth redirects unauthenticated visitors here.
    signIn: '/login',
    error: '/login',
  },

  providers: [
    Credentials({
      id: 'credentials',
      name: 'Email and password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(rawCredentials) {
        // Validate first — bail out cheaply on malformed bodies.
        const parsed = credentialsSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          throw new InvalidCredentialsError();
        }
        const { email, password } = parsed.data;

        const user = await prisma.user.findUnique({
          where: { email },
          select: {
            id: true,
            email: true,
            name: true,
            role: true,
            passwordHash: true,
            isActive: true,
            moduleAccess: true,
          },
        });

        // Generic failure for missing user, deactivated user, or wrong
        // password — never tell the client which one matched.
        if (!user || !user.isActive) {
          throw new InvalidCredentialsError();
        }

        const passwordOk = await compare(password, user.passwordHash);
        if (!passwordOk) {
          throw new InvalidCredentialsError();
        }

        // Returned shape is fed into the `jwt` callback as `user` on
        // first sign-in. See `src/types/next-auth.d.ts#User`.
        return {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          moduleAccess: user.moduleAccess,
        };
      },
    }),
  ],

  callbacks: {
    /**
     * Persist `userId` and `role` on the JWT and periodically re-check
     * the user's `isActive` flag against Postgres.
     *
     * Two distinct invocation modes:
     *
     *   1. **Initial sign-in.** `user` is the object returned by
     *      `authorize()` above. We stamp `userId`, `role`, and `chk`
     *      (a "last checked at" millisecond timestamp) onto the token
     *      and return it. No DB lookup — `authorize()` already verified
     *      `isActive` directly.
     *
     *   2. **Subsequent request.** `user` is undefined; NextAuth has
     *      just decoded the existing JWT from the cookie. We see
     *      whether more than {@link ISACTIVE_RECHECK_INTERVAL_MS} has
     *      elapsed since the last DB check (or there was no check on
     *      file at all) and, if so, requery `User.isActive` / `role`:
     *
     *        - `isActive === false` OR row missing → clear `userId` and
     *          mark `deactivated: true`. The session callback then
     *          surfaces a session without `userId`, and any
     *          `requireSession()` call 401s. Middleware also redirects
     *          to `/login`.
     *        - `isActive === true` → refresh `role` (in case it was
     *          changed via PATCH /api/users/[id]) and stamp `chk = now`.
     *        - DB unreachable → log and keep the cached state. We
     *          deliberately choose availability over revocation here: a
     *          brief Postgres blip should NOT carpet-401 every active
     *          session. The tradeoff is that revocation latency widens
     *          while the DB is unreachable. Mutating routes that touch
     *          Postgres will fail naturally during the same blip, so
     *          the worst a "still-allowed" deactivated user can do is
     *          read cached data until the next successful re-check.
     *
     * Latency contract: a user deactivated via `DELETE /api/users/[id]`
     * loses access within at most {@link ISACTIVE_RECHECK_INTERVAL_MS}
     * (~5 minutes). Document this in any "deactivate user" runbook.
     */
    async jwt({ token, user }) {
      if (user) {
        // Initial sign-in. `user.id` is optional in the upstream `User`
        // type but `authorize()` always returns it for the credentials
        // flow, so guard defensively.
        if (user.id) {
          token.userId = user.id;
        }
        if (user.role) {
          token.role = user.role;
        }
        // `authorize()` always selects `moduleAccess`; default to an
        // empty array if a future provider returns a user without it.
        token.moduleAccess = user.moduleAccess ?? [];
        // Stamp the check timestamp so the first post-login re-check
        // doesn't fire for another full interval — we just verified
        // `isActive` inside `authorize()`.
        token.chk = Date.now();
        return token;
      }

      // Subsequent invocation. Re-check `isActive` only if the cached
      // value is stale. If we haven't recorded a check yet (legacy
      // pre-FIX tokens), treat it as immediately stale so the very next
      // request after deploy re-validates.
      const lastChecked = token.chk ?? 0;
      const isStale = Date.now() - lastChecked > ISACTIVE_RECHECK_INTERVAL_MS;

      if (!isStale || !token.userId) {
        return token;
      }

      try {
        const dbUser = await prisma.user.findUnique({
          where: { id: token.userId },
          // Pull the columns that gate access — keeps the per-request
          // query cheap even at scale. `moduleAccess` rides along so an
          // admin's update to the whitelist propagates within one
          // re-check interval.
          select: { isActive: true, role: true, moduleAccess: true },
        });

        if (!dbUser || !dbUser.isActive) {
          // Either hard-deleted or soft-deactivated. Clear the
          // identifying claim so the session callback can't surface a
          // usable session. Setting `deactivated` lets the session
          // callback log/branch if it ever needs to distinguish "no
          // session" from "revoked session".
          delete token.userId;
          token.deactivated = true;
          return token;
        }

        // Healthy row — refresh role (admin might have demoted the user
        // via PATCH), refresh moduleAccess, and update the check
        // timestamp.
        token.role = dbUser.role;
        token.moduleAccess = dbUser.moduleAccess ?? [];
        token.chk = Date.now();
        token.deactivated = false;
      } catch (err) {
        // Postgres is briefly unreachable. Per the design note above,
        // we keep the cached session rather than nuking everyone's
        // access during a connection blip. The next request after the
        // DB recovers will retry (we deliberately do NOT bump `chk` so
        // the staleness check fires again immediately).
        // eslint-disable-next-line no-console
        console.error('[auth] isActive re-check failed; keeping cached session', err);
      }

      return token;
    },

    /**
     * Surface `userId` and `role` on the resolved Session object so
     * `await auth()` callers can read them directly without going back
     * to the database. Also mirror them on `session.user` for
     * compatibility with code that reads `session.user.id`.
     *
     * A token without `userId` (which the `jwt` callback above produces
     * for deactivated/deleted users) yields a session with no
     * `userId` / `role` — `requireSession()` in `src/lib/api-helpers.ts`
     * then 401s, and the Edge middleware's `Boolean(session?.userId)`
     * check sends the page navigation to `/login`.
     */
    async session({ session, token }) {
      if (token.userId) {
        session.userId = token.userId;
        session.role = token.role;
        session.moduleAccess = token.moduleAccess ?? [];
        if (session.user) {
          session.user.id = token.userId;
          session.user.role = token.role;
        }
      }
      return session;
    },
  },

  // Disable Auth.js debug logs in production; let them bubble up in dev.
  debug: process.env.NODE_ENV === 'development',
};

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Auth.js v5 returns the standard `{ handlers, auth, signIn, signOut }`
 * quartet. Re-export each symbol so consumers can `import { auth } from
 * '@/lib/auth'` without destructuring at the call site.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
