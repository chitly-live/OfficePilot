/**
 * Server actions scoped to the `(app)` route group.
 *
 * Why a dedicated file?
 * --------------------
 * `@/lib/auth` pulls in Prisma + bcryptjs and is ONLY safe under the
 * Node runtime. By putting the `signOut` server action here (instead of
 * importing it directly from a `'use client'` file) we get a clean
 * boundary: the client side only imports the action *reference*, while
 * the implementation stays server-side. See SPEC §2.2 for the auth
 * flow this powers.
 *
 * The action itself is intentionally tiny — Auth.js v5's `signOut`
 * already clears the session cookie and (with `redirectTo`) issues the
 * redirect via a thrown `NEXT_REDIRECT` error that Next.js catches at
 * the server-action boundary.
 */

'use server';

import { signOut } from '@/lib/auth';

/**
 * Clears the session cookie and bounces the user to `/login`.
 *
 * Wired up via `<form action={signOutAction}>` in the topbar dropdown
 * and the sidebar footer. Using a form (instead of an `onClick` POST
 * from a client component) keeps the sign-out path functional even
 * when JS hasn't hydrated yet.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/login' });
}
