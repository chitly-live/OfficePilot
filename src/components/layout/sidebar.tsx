'use client';

/**
 * Sidebar — primary nav for the `(app)` route group.
 *
 * Rendered by `src/app/(app)/layout.tsx` in two flavours:
 *
 *   • Desktop (≥ lg): a fixed 240 px column on the left of the grid
 *     shell (SPEC §13.1: "sidebar nav: collapsible, icons + labels").
 *   • Mobile (< lg): the same content embedded inside the topbar's
 *     `Sheet` drawer (SPEC §13.2: "sidebar collapses to hamburger on
 *     <768px"). We only switch breakpoint at `lg` (1024 px) so the
 *     sidebar also tucks away on tablet portrait — denser usable area
 *     for tables and Kanban boards.
 *
 * Client component because:
 *   1. `usePathname()` drives the active-state highlight.
 *   2. The mobile variant fires `onNavigate` to close the parent Sheet
 *      after the user picks a destination — a pure server component
 *      can't hold that callback reference.
 *
 * Nav items map 1:1 to SPEC §4 page inventory. Order is intentional:
 *   Dashboard · Employees · Leads · Marketing · Social · Dev · AI ·
 *   Settings (admin-gated last, after a separator).
 *
 * Role gating: the middleware already enforces ADMIN-only access to
 * `/ai`, `/api/ai/usage`, `/settings/users`, `/api/settings`, `/api/users`
 * (see `src/middleware.ts`). We mirror that in the UI by hiding `AI
 * Analysis` from non-admins so they don't see a link that would just
 * redirect them back to /dashboard — better UX than a dead link.
 * `/settings` itself stays visible because employees can still hit
 * the personal-settings page; only `/settings/users` is admin-only.
 *
 * Per-module gating: EMPLOYEE users with a non-empty `moduleAccess`
 * whitelist also have nav entries filtered out when they would resolve
 * to a module the user can't access. Admins bypass the filter via
 * `canAccessModule`, and legacy employees (empty `moduleAccess`) see
 * everything per `canAccessModule`'s legacy semantics.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Code2,
  LayoutDashboard,
  Megaphone,
  Settings,
  Share2,
  Sparkles,
  UserPlus,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import type { Role } from '@prisma/client';

import { Separator } from '@/components/ui/separator';
import { canAccessModule, type ModuleId } from '@/lib/permissions';
import { cn } from '@/lib/utils';

import { SignOutButton } from './sign-out-button';

// ---------------------------------------------------------------------------
// Nav configuration
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** When true, only ADMIN sessions see this entry. */
  adminOnly?: boolean;
  /** Per-module gate (`canAccessModule`). When omitted, the item is
   *  always visible to any authenticated session (e.g. Settings). */
  module?: ModuleId;
}

/** Primary nav — SPEC §4 page inventory, in user-facing order. */
const PRIMARY_NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, module: 'dashboard' },
  { href: '/employees', label: 'Employees', icon: Users, module: 'employees' },
  { href: '/leads', label: 'Leads', icon: UserPlus, module: 'leads' },
  { href: '/marketing', label: 'Marketing', icon: Megaphone, module: 'marketing' },
  { href: '/social', label: 'Social', icon: Share2, module: 'social' },
  { href: '/dev', label: 'Dev', icon: Code2, module: 'dev' },
  { href: '/finance', label: 'Finance', icon: Wallet, adminOnly: true },
  { href: '/ai', label: 'AI Analysis', icon: Sparkles, adminOnly: true },
];

/** Footer nav — settings sits below a separator to visually distinguish
 *  "configuration" from "everyday work" surfaces. */
const SECONDARY_NAV: NavItem[] = [
  { href: '/settings', label: 'Settings', icon: Settings },
];

/**
 * Active-state matcher. A nav item is "active" when the current path is
 * the item's href or a descendant of it (`/leads/123` highlights the
 * `Leads` entry). `/dashboard` is the only exception — exact match
 * only, otherwise it would steal highlight from every other route.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/dashboard') {
    return pathname === '/dashboard';
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

// ---------------------------------------------------------------------------
// Subcomponents
// ---------------------------------------------------------------------------

interface BrandProps {
  /** Closes the parent Sheet on mobile when the brand mark is clicked. */
  onNavigate?: () => void;
}

/**
 * Indigo wordmark at the top of the sidebar (SPEC §13.1 indigo accent).
 * Doubles as a "home" link to `/dashboard`.
 */
function Brand({ onNavigate }: BrandProps) {
  return (
    <Link
      href="/dashboard"
      onClick={onNavigate}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5',
        'transition-colors hover:bg-accent',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      aria-label="OfficePilot home"
    >
      <span
        aria-hidden="true"
        className="
          flex h-8 w-8 items-center justify-center rounded-md
          bg-brand-600 text-sm font-semibold text-white
          shadow-sm
        "
      >
        OP
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Office<span className="text-brand-600">Pilot</span>
        </span>
        <span className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
          Chitly
        </span>
      </span>
    </Link>
  );
}

interface NavLinkProps {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
}

/**
 * Single nav row. Active state uses the brand indigo (SPEC §13.1) on a
 * tinted background; inactive rows are muted text on transparent.
 */
function NavLink({ item, active, onNavigate }: NavLinkProps) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium',
        'transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active
          ? 'bg-brand-50 text-brand-700 dark:bg-brand-900/40 dark:text-brand-200'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      <Icon
        className={cn(
          'h-4 w-4 shrink-0',
          active ? 'text-brand-600 dark:text-brand-300' : undefined,
        )}
        aria-hidden="true"
      />
      <span className="truncate">{item.label}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface SidebarProps {
  /** Current user's role — drives admin-only nav visibility. */
  role: Role;
  /** Per-module whitelist from `session.moduleAccess`. Empty / undefined
   *  means "legacy / full access" per `canAccessModule`. */
  moduleAccess?: string[];
  /** Fired after any nav link is clicked. The mobile `Sheet` wrapper
   *  passes a setter that closes the drawer; on desktop this is
   *  omitted. */
  onNavigate?: () => void;
}

export function Sidebar({ role, moduleAccess, onNavigate }: SidebarProps) {
  const pathname = usePathname() ?? '';
  const isAdmin = role === 'ADMIN';

  const accessUser = { role, moduleAccess: moduleAccess ?? [] };

  const visiblePrimary = PRIMARY_NAV.filter((item) => {
    if (item.adminOnly) return isAdmin;
    if (!item.module) return true;
    return canAccessModule(accessUser, item.module);
  });

  return (
    <div className="flex h-full flex-col gap-4 px-3 py-4">
      <Brand onNavigate={onNavigate} />

      <Separator />

      <nav aria-label="Primary" className="flex-1 overflow-y-auto">
        <ul className="flex flex-col gap-0.5">
          {visiblePrimary.map((item) => (
            <li key={item.href}>
              <NavLink
                item={item}
                active={isActive(pathname, item.href)}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>

        <Separator className="my-3" />

        <ul className="flex flex-col gap-0.5">
          {SECONDARY_NAV.map((item) => (
            <li key={item.href}>
              <NavLink
                item={item}
                active={isActive(pathname, item.href)}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-auto">
        <Separator className="mb-3" />
        <SignOutButton variant="sidebar" />
      </div>
    </div>
  );
}
