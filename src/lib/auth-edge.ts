/**
 * Edge-safe NextAuth (Auth.js v5) configuration for OfficePilot.
 *
 * Why this file exists
 * --------------------
 * `src/lib/auth.ts` carries the full Auth.js config — Credentials
 * provider, `prisma.user.findUnique`, `bcryptjs.compare`. Those imports
 * pull in Node-only APIs (`crypto`, `pg` driver, etc.) and are NOT
 * compatible with the Edge runtime, which is where Next.js middleware
 * runs.
 *
 * Auth.js v5 anticipates this exact split. We mirror the official
 * recommendation (https://authjs.dev/guides/edge-compatibility):
 *
 *   • A trimmed config (this file) — no providers, no DB access, just
 *     `secret`, `session`, `pages`, and the `session` callback that
 *     surfaces `userId` / `role` from the existing JWT.
 *   • The full config (`src/lib/auth.ts`) — used by the
 *     `/api/auth/[...nextauth]` route handler under the Node runtime.
 *
 * Both configs share the same `NEXTAUTH_SECRET`, so a JWT minted by the
 * Node-side Credentials sign-in flow is verifiable here on the edge.
 * Middleware only needs to *verify* the JWT and read `role` for RBAC
 * gating — it never re-issues credentials.
 *
 * Used by `src/middleware.ts` (task 18). Do NOT import this from route
 * handlers — keep the contract clean by using `@/lib/auth` there.
 */

import NextAuth, { type NextAuthConfig } from 'next-auth';

/** 7-day session lifetime, kept identical to `@/lib/auth` so cookie
 *  metadata matches across runtimes. */
const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60;

export const authEdgeConfig: NextAuthConfig = {
  // Same secret as `@/lib/auth` so JWTs minted by the Node-side
  // Credentials provider are accepted here.
  secret: process.env.NEXTAUTH_SECRET,

  session: {
    strategy: 'jwt',
    maxAge: SEVEN_DAYS_IN_SECONDS,
    updateAge: 0,
  },

  pages: {
    signIn: '/login',
    error: '/login',
  },

  // No providers on the edge — Credentials sign-in (which needs Prisma
  // + bcrypt) only runs through `/api/auth/*` under the Node runtime.
  providers: [],

  callbacks: {
    /**
     * Surface `userId` and `role` from the JWT onto the resolved
     * Session so `req.auth.role` is available in middleware. The JWT
     * itself is populated by the Node-side `jwt` callback in
     * `@/lib/auth.ts` at sign-in time; we only mirror the values here.
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
};

/**
 * Edge-safe `auth` helper. Use as a middleware wrapper:
 *   `export default auth((req) => { ... })`
 * where `req.auth` is the resolved Session (or `null` when no valid
 * cookie is present).
 */
export const { auth } = NextAuth(authEdgeConfig);
