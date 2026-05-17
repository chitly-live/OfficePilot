'use client';

/**
 * Topbar — global header for the `(app)` shell.
 *
 * Lives above the page content area on every authenticated route.
 * Per SPEC §13.1: "topbar: search (cmd+k), notifications, user menu".
 * Layout (left → right):
 *
 *   1. Hamburger (mobile only) — opens the sidebar `Sheet` drawer.
 *      Hidden on `lg`+ where the sidebar is permanently visible.
 *   2. Search input — placeholder for now (cmd+k landing in a later
 *      task; we still render the chrome so the page shape is stable
 *      from day one).
 *   3. Quick-add button — placeholder; task 61 wires the cross-page
 *      DevTask quick-add modal to it.
 *   4. User menu — avatar with name + role + sign out.
 *
 * Client component because:
 *   • The `Sheet` open/close state is local React state.
 *   • The shadcn `DropdownMenu` and `Sheet` primitives need a client
 *     boundary anyway.
 *
 * Mobile sidebar gets the SAME `<Sidebar />` component as desktop —
 * we just embed it inside `SheetContent` and pass an `onNavigate`
 * handler that closes the drawer after a link click. Single source of
 * truth for nav structure.
 */

import { useState } from 'react';
import { Menu, Search } from 'lucide-react';
import type { Role } from '@prisma/client';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

import { QuickAddModal } from './quick-add-modal';
import { Sidebar } from './sidebar';
import { SignOutButton } from './sign-out-button';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Two-letter avatar fallback. Picks the first letter of the first two
 * whitespace-separated tokens in `name` (so "Lal Singh" → "LS"). Falls
 * back to the email initial if `name` is empty, and finally to "?" so
 * we never render an empty circle.
 */
function getInitials(name: string | null | undefined, email: string): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromEmail = email.trim()[0];
  return (fromEmail ?? '?').toUpperCase();
}

/**
 * User-facing role label. Prisma enum values are uppercase; the UI
 * surfaces sentence case for readability.
 */
function formatRole(role: Role): string {
  return role === 'ADMIN' ? 'Admin' : 'Employee';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface TopbarProps {
  user: {
    id: string;
    name: string | null;
    email: string;
    role: Role;
    /** Per-module whitelist forwarded to the mobile Sidebar so the
     *  drawer matches the desktop nav filter. */
    moduleAccess?: string[];
  };
}

export function Topbar({ user }: TopbarProps) {
  const [mobileOpen, setMobileOpen] = useState(false);

  const initials = getInitials(user.name, user.email);
  const displayName = user.name?.trim() || user.email;

  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-background px-3 sm:px-4',
        'backdrop-blur supports-[backdrop-filter]:bg-background/85',
      )}
    >
      {/* Mobile-only hamburger → opens the sidebar drawer. */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label="Open navigation menu"
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-72 p-0 sm:max-w-xs">
          {/* Visually hidden title — required by Radix Dialog for a11y. */}
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <Sidebar
            role={user.role}
            moduleAccess={user.moduleAccess}
            onNavigate={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>

      {/* Search — placeholder until cmd+k palette lands. */}
      <div className="relative flex-1 max-w-xl">
        <Search
          className="
            pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2
            text-muted-foreground
          "
          aria-hidden="true"
        />
        <Input
          type="search"
          placeholder="Search…"
          aria-label="Search"
          disabled
          className="pl-9"
        />
      </div>

      {/* Quick-add — opens the cross-page modal that creates a Lead,
          Campaign, Social post, or Dev task from any page (SPEC §9.2.5). */}
      <QuickAddModal currentUserId={user.id} />

      {/* User menu. */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="rounded-full"
            aria-label="Open user menu"
          >
            <Avatar className="h-8 w-8">
              <AvatarFallback className="bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                {initials}
              </AvatarFallback>
            </Avatar>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel className="flex flex-col gap-0.5 py-2">
            <span className="text-sm font-semibold leading-tight text-foreground">
              {displayName}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {user.email}
            </span>
            <span className="mt-1 inline-flex w-fit items-center rounded-full bg-brand-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-brand-700 dark:bg-brand-900/40 dark:text-brand-200">
              {formatRole(user.role)}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {/* Render the sign-out form directly (not wrapped in
              DropdownMenuItem) — DropdownMenuItem's `onSelect` would
              steal the click before the form submits. The styling on
              SignOutButton's "menu-item" variant matches the menu
              row look. */}
          <div className="p-1">
            <SignOutButton variant="menu-item" />
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  );
}
