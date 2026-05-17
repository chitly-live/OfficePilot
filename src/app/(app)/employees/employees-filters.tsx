'use client';

/**
 * EmployeesFilters — URL-driven filter bar for `/employees`.
 *
 * Three controls feed straight into the page's `searchParams` so the
 * back button and deep links work as expected:
 *
 *   • `search`   — debounced text input (name + email).
 *   • `role`     — Select with `all / ADMIN / EMPLOYEE` options.
 *   • `isActive` — Select with `all / true / false` options.
 *
 * Strategy: each control updates the URL immediately (via
 * `router.replace`) using a fresh `URLSearchParams` derived from the
 * current `useSearchParams()`. Page reads `searchParams` server-side,
 * the page re-renders, the table updates. We always reset `page=1`
 * on filter change so the user doesn't land on an empty page after
 * narrowing the filter.
 *
 * Why a client component?
 *   • `useSearchParams` + `useRouter` are client-only hooks.
 *   • Debouncing the search input requires React state.
 *   • Native `<select>` is enough here — we keep the dependency
 *     surface lean and avoid hydrating a Radix Select for two
 *     three-option dropdowns.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the free-text search input. */
const SEARCH_DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface EmployeesFiltersProps {
  /** Initial search text (from the URL on first render). */
  defaultSearch: string;
  /** Initial role filter — `'all' | 'ADMIN' | 'EMPLOYEE'`. */
  defaultRole: string;
  /** Initial active filter — `'all' | 'true' | 'false'`. */
  defaultIsActive: string;
}

export function EmployeesFilters({
  defaultSearch,
  defaultRole,
  defaultIsActive,
}: EmployeesFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // The text input is locally controlled so we can debounce it; the
  // selects push to the URL synchronously.
  const [searchValue, setSearchValue] = React.useState(defaultSearch);

  /**
   * Build a fresh URL from the current params with the given
   * overrides. `undefined`/`''` means "remove this key". `page` is
   * always reset to 1 on filter change.
   */
  const pushFilter = React.useCallback(
    (overrides: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || value === '') {
          next.delete(key);
        } else {
          next.set(key, value);
        }
      }
      // Reset pagination — narrowing filters always returns to page 1.
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `/employees?${qs}` : '/employees', {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  // Debounce the search input. Only push when the value actually
  // changed from what's already in the URL — avoids redundant pushes
  // during the initial render.
  React.useEffect(() => {
    const trimmed = searchValue.trim();
    const current = searchParams?.get('search') ?? '';
    if (trimmed === current) return;

    const handle = window.setTimeout(() => {
      pushFilter({ search: trimmed === '' ? undefined : trimmed });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchValue, searchParams, pushFilter]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="relative flex-1">
        <Label htmlFor="employees-search" className="sr-only">
          Search employees
        </Label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="employees-search"
          type="search"
          placeholder="Search by name or email…"
          autoComplete="off"
          className="pl-9"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="employees-role" className="text-xs">
          Role
        </Label>
        <select
          id="employees-role"
          className={selectClasses}
          defaultValue={defaultRole}
          onChange={(e) =>
            pushFilter({
              role: e.target.value === 'all' ? undefined : e.target.value,
            })
          }
        >
          <option value="all">All roles</option>
          <option value="ADMIN">Admin</option>
          <option value="EMPLOYEE">Employee</option>
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="employees-active" className="text-xs">
          Status
        </Label>
        <select
          id="employees-active"
          className={selectClasses}
          defaultValue={defaultIsActive}
          onChange={(e) =>
            pushFilter({
              isActive: e.target.value === 'all' ? undefined : e.target.value,
            })
          }
        >
          <option value="all">All</option>
          <option value="true">Active</option>
          <option value="false">Inactive</option>
        </select>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const selectClasses = cn(
  'h-10 rounded-md border border-input bg-background px-3 py-2 text-sm',
  'ring-offset-background placeholder:text-muted-foreground',
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
  'disabled:cursor-not-allowed disabled:opacity-50',
  'sm:w-40',
);
