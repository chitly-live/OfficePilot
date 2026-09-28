'use client';

/**
 * Sub-navigation for the Finance module: Overview · Dues · Transactions ·
 * Parties · Accounts · Assets · Reconcile · GST. Client component only for
 * the active-state highlight via `usePathname()`. Wraps on narrow screens.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowLeftRight,
  CalendarClock,
  CheckCheck,
  LayoutDashboard,
  Landmark,
  Package,
  ReceiptText,
  Users,
} from 'lucide-react';

import { cn } from '@/lib/utils';

const ITEMS = [
  { href: '/finance', label: 'Overview', icon: LayoutDashboard, exact: true },
  { href: '/finance/dues', label: 'Dues', icon: CalendarClock },
  { href: '/finance/transactions', label: 'Transactions', icon: ArrowLeftRight },
  { href: '/finance/parties', label: 'Parties', icon: Users },
  { href: '/finance/accounts', label: 'Accounts', icon: Landmark },
  { href: '/finance/assets', label: 'Assets', icon: Package },
  { href: '/finance/reconcile', label: 'Reconcile', icon: CheckCheck },
  { href: '/finance/gst', label: 'GST', icon: ReceiptText },
] as const;

export function FinanceNav() {
  const pathname = usePathname() ?? '';

  return (
    <nav
      aria-label="Finance sections"
      className="flex flex-wrap items-center gap-1 rounded-md border bg-muted/30 p-1"
    >
      {ITEMS.map((item) => {
        const active =
          'exact' in item && item.exact
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-sm font-medium transition-colors',
              active
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="h-4 w-4" aria-hidden="true" />
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
