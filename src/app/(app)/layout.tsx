/**
 * Root layout for the authenticated app shell — `(app)` route group.
 *
 * Server Component. Responsibilities (per SPEC §4 page inventory and
 * §13 design system):
 *
 *   1. Resolve the current session via `auth()`. If absent, redirect
 *      to `/login` with a `callbackUrl` so the user lands back on the
 *      page they tried to visit. Note: `src/middleware.ts` already does
 *      this for any matched path, but we redo the check here as a
 *      defence-in-depth — middleware can be misconfigured or skipped
 *      for some paths, and pages downstream of this layout assume a
 *      non-null session when reading `session.userId`.
 *   2. Render the persistent shell: a 240 px sidebar on the left
 *      (collapsed into a Sheet drawer on < lg), a sticky topbar on top,
 *      and the page content in the remaining area.
 *
 * Layout uses a CSS grid keyed off `lg` (1024 px). Below `lg` the grid
 * collapses to a single column — sidebar disappears from the page flow
 * and only opens via the topbar hamburger (rendered by `<Topbar />`).
 *
 * Why pull `name`/`email`/`role` out of the session here?
 *   The session object on the client side only carries `user.id` and
 *   `user.role` reliably (see `src/types/next-auth.d.ts`). Name and
 *   email are nice-to-haves for the user menu, and we let the topbar
 *   (a client component) accept them as props rather than re-fetching
 *   in the browser.
 */

import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';

import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { auth } from '@/lib/auth';

interface AppLayoutProps {
  children: ReactNode;
}

export default async function AppLayout({ children }: AppLayoutProps) {
  const session = await auth();

  // Defence-in-depth — middleware should already have redirected, but
  // any layout downstream of this assumes session.userId is set.
  if (!session?.userId) {
    redirect('/login');
  }

  // `session.user` carries name/email from the JWT (populated by the
  // Auth.js v5 default `session` shape on top of our augmentation).
  // Defaulting to empty string keeps the topbar's avatar-initials
  // fallback logic happy even for users whose `name` is null. The
  // `id` is forwarded so the cross-page Quick Add modal can default
  // dev-task assignees to "me" (SPEC.md §9.2.5).
  const userMenu = {
    id: session.userId,
    name: session.user?.name ?? null,
    email: session.user?.email ?? '',
    role: session.role,
    moduleAccess: session.moduleAccess ?? [],
  };

  return (
    <div
      className="
        grid min-h-screen w-full bg-background text-foreground
        lg:grid-cols-[240px_minmax(0,1fr)]
      "
    >
      {/* Desktop sidebar — sticky at the viewport top so nav stays in
          place while content scrolls. Hidden on < lg; the topbar's
          Sheet-based mobile drawer renders the same component. */}
      <aside
        aria-label="Primary navigation"
        className="
          hidden lg:sticky lg:top-0 lg:flex lg:h-screen lg:flex-col
          lg:border-r lg:bg-background
        "
      >
        <Sidebar role={session.role} moduleAccess={session.moduleAccess ?? []} />
      </aside>

      {/* Right column: topbar + main content. `min-w-0` is essential —
          without it, wide tables inside `children` push the grid track
          and break the layout. */}
      <div className="flex min-w-0 flex-col">
        <Topbar user={userMenu} />
        <main className="flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
