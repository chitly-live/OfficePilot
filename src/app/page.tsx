/**
 * `/` — root entry point.
 *
 * Server Component that performs a session-aware redirect:
 *   • Authenticated → `/dashboard` (the unified cockpit, SPEC §11)
 *   • Anonymous     → `/login`
 *
 * `src/middleware.ts` (task 18) only matches `/(app)/*` and `/api/*`,
 * so the bare `/` path falls through to this page; the server-side
 * redirect here is the canonical way to land users in the right place.
 *
 * Marked `dynamic = 'force-dynamic'` so the redirect always reflects
 * the current session cookie instead of a static build-time snapshot.
 */

import { redirect } from 'next/navigation';

import { auth } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function RootPage() {
  const session = await auth();

  if (session?.userId) {
    redirect('/dashboard');
  }

  redirect('/login');
}
