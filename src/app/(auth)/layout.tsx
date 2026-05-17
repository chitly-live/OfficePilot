/**
 * Route-group layout for `/(auth)/*` pages (login, plus any future
 * password-reset or first-time-setup screens).
 *
 * The `(auth)` segment is a Next.js route group — parentheses keep it
 * out of the URL so this layout wraps `/login` (and siblings) without
 * adding a `/auth/...` prefix. It deliberately does NOT render the
 * Sidebar/Topbar shell from `src/app/(app)/layout.tsx`; auth screens
 * are full-bleed and chrome-free per SPEC §13.
 *
 * Visual style: neutral background with a subtle indigo gradient
 * accent (#6366f1, SPEC §13.1) so the branded card pops without
 * looking like a marketing page. Mobile-friendly: the centered flex
 * column keeps the card readable on small screens.
 */

import type { ReactNode } from 'react';

interface AuthLayoutProps {
  children: ReactNode;
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <main
      className="
        relative flex min-h-screen w-full items-center justify-center
        overflow-hidden bg-background px-4 py-10
      "
    >
      {/* Decorative indigo gradient blobs — purely visual, hidden from
          assistive tech. Sized in vw so they scale gracefully. */}
      <div
        aria-hidden="true"
        className="
          pointer-events-none absolute -top-32 -left-32 h-[40vw] w-[40vw]
          rounded-full bg-brand-200/40 blur-3xl
          dark:bg-brand-900/30
        "
      />
      <div
        aria-hidden="true"
        className="
          pointer-events-none absolute -bottom-32 -right-32 h-[40vw] w-[40vw]
          rounded-full bg-brand-100/40 blur-3xl
          dark:bg-brand-800/30
        "
      />

      <div className="relative z-10 w-full max-w-md">{children}</div>
    </main>
  );
}
