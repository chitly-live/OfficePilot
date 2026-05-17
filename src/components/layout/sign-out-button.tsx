/**
 * Sign-out trigger.
 *
 * A plain `<form>` posting to the `signOutAction` server action — no
 * `'use client'` boundary needed. Renders as either a full-width
 * sidebar button (`variant="sidebar"`) or a dropdown menu row
 * (`variant="menu-item"`), so the same component drives both the
 * sidebar footer and the topbar user menu.
 *
 * Using a form (rather than an `onClick`-driven client component)
 * means sign-out keeps working even before React hydrates, and the
 * request is a normal POST that follows Auth.js's `redirectTo` —
 * cookie cleared on the response, browser bounced to `/login`.
 */

import { LogOut } from 'lucide-react';

import { signOutAction } from '@/app/(app)/actions';
import { cn } from '@/lib/utils';

interface SignOutButtonProps {
  /**
   * Visual treatment. `sidebar` matches the side-nav row layout
   * (full-width, ghost button); `menu-item` matches a shadcn
   * `DropdownMenuItem` so it sits naturally inside the user menu.
   */
  variant?: 'sidebar' | 'menu-item';
}

export function SignOutButton({ variant = 'sidebar' }: SignOutButtonProps) {
  const buttonClassName =
    variant === 'sidebar'
      ? cn(
          'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
          'text-muted-foreground transition-colors',
          'hover:bg-accent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        )
      : cn(
          'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm',
          'text-foreground transition-colors',
          'hover:bg-accent hover:text-accent-foreground',
          'focus-visible:outline-none focus-visible:bg-accent focus-visible:text-accent-foreground',
        );

  return (
    <form action={signOutAction} className="w-full">
      <button type="submit" className={buttonClassName}>
        <LogOut className="h-4 w-4" aria-hidden="true" />
        <span>Sign out</span>
      </button>
    </form>
  );
}
