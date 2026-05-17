/**
 * NextAuth (Auth.js v5) type augmentation for OfficePilot.
 *
 * Adds `userId` and `role` to both the JWT payload and the resolved
 * Session object so that `auth()` callers (route handlers, RSCs,
 * middleware) can pull `session.userId` and `session.role` directly
 * without re-querying the database.
 *
 * Source of truth: design.md "Roles, Auth, and Permissions" — every
 * `(app)/*` and `/api/*` (except auth/webhooks/cron) gates on these two
 * fields, and `src/lib/permissions.ts#PermissionSession` requires them.
 *
 * IMPORTANT: this file ONLY augments existing module declarations. It
 * MUST NOT contain any `import` of values; otherwise TypeScript treats
 * it as a module and the `declare module 'next-auth'` blocks become
 * scoped re-declarations rather than augmentations.
 */

import type { Role } from '@prisma/client';
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  /**
   * Returned by `auth()`, `useSession()`, `getSession()`, and exposed in
   * the `session` callback. Carries the authenticated user's database id
   * and RBAC role alongside the default fields (name, email, image).
   *
   * `moduleAccess` carries the per-module whitelist for EMPLOYEE
   * sessions; see `src/lib/permissions.ts#canAccessModule`. It is the
   * raw `User.moduleAccess` string array — empty for legacy / "full
   * access" users.
   */
  interface Session {
    userId: string;
    role: Role;
    moduleAccess?: string[];
    user: {
      id: string;
      role: Role;
    } & DefaultSession['user'];
  }

  /**
   * Shape of the object returned from the Credentials provider's
   * `authorize()` callback. NextAuth feeds this into the `jwt` callback
   * on first sign-in.
   */
  interface User {
    id: string;
    email: string;
    name: string;
    role: Role;
    moduleAccess?: string[];
  }
}

declare module 'next-auth/jwt' {
  /**
   * Persistent JWT payload between requests. 7-day sliding session.
   *
   * `userId` is optional at the type level because the `jwt` callback in
   * `src/lib/auth.ts` deletes it when a user is deactivated (panel-audit gap
   * B4 (v0.1.2)) — that's how a revoked token surfaces as a session without
   * `userId`, which the `requireSession()` guard and Edge middleware
   * both interpret as "unauthenticated".
   *
   * `chk` is the millisecond timestamp of the last successful
   * `isActive` re-check. `deactivated` is a sticky flag set by the
   * callback after a successful re-check confirmed the row is inactive
   * (or hard-deleted), so a downstream caller can distinguish "no
   * session at all" from "session was revoked".
   *
   * `moduleAccess` is the per-module whitelist refreshed alongside
   * `role` on each `isActive` re-check.
   */
  interface JWT {
    userId?: string;
    role: Role;
    chk?: number;
    deactivated?: boolean;
    moduleAccess?: string[];
  }
}

declare module '@auth/core/jwt' {
  /**
   * Mirror of the `next-auth/jwt` augmentation. Required because
   * `next-auth/jwt` re-exports `*` from `@auth/core/jwt`, but the JWT
   * passed to the `jwt` and `session` callbacks is resolved against the
   * `@auth/core/jwt` interface — so we have to extend both.
   */
  interface JWT {
    userId?: string;
    role: Role;
    chk?: number;
    deactivated?: boolean;
    moduleAccess?: string[];
  }
}

declare module '@auth/core/types' {
  interface Session {
    userId: string;
    role: Role;
    moduleAccess?: string[];
  }

  interface User {
    role?: Role;
    moduleAccess?: string[];
  }
}
