'use client';

/**
 * SocialViewToggle — segmented switch between the calendar and list
 * views for `/social` (SPEC.md §8.1, §8.2.1).
 *
 * Persists the selection in `?view=calendar|list` so deep links and
 * the back button preserve the user's preferred view. Default is
 * `calendar` — SPEC.md §8.1 lists the calendar first.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CalendarDays, List } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type SocialView = 'calendar' | 'list';

export interface SocialViewToggleProps {
  current: SocialView;
}

export function SocialViewToggle({ current }: SocialViewToggleProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setView = React.useCallback(
    (next: SocialView) => {
      if (next === current) return;
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      // `calendar` is the default — drop the param when selecting it.
      if (next === 'calendar') {
        params.delete('view');
      } else {
        params.set('view', next);
      }
      // Reset pagination — the calendar view ignores it anyway, but
      // the list view should start at page 1 when the user toggles
      // back from a paginated state.
      params.delete('page');
      const qs = params.toString();
      router.replace(qs ? `/social?${qs}` : '/social', { scroll: false });
    },
    [current, router, searchParams],
  );

  return (
    <div
      className="inline-flex rounded-md border bg-background p-0.5"
      role="tablist"
      aria-label="View mode"
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        role="tab"
        aria-selected={current === 'calendar'}
        className={cn(
          'h-8 rounded-sm px-3',
          current === 'calendar' && 'bg-accent text-accent-foreground',
        )}
        onClick={() => setView('calendar')}
      >
        <CalendarDays className="h-4 w-4" aria-hidden="true" />
        <span>Calendar</span>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        role="tab"
        aria-selected={current === 'list'}
        className={cn(
          'h-8 rounded-sm px-3',
          current === 'list' && 'bg-accent text-accent-foreground',
        )}
        onClick={() => setView('list')}
      >
        <List className="h-4 w-4" aria-hidden="true" />
        <span>List</span>
      </Button>
    </div>
  );
}
