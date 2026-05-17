'use client';

/**
 * ScopeTabs — client island that renders the scope filter as shadcn
 * Tabs and pushes `?scope=` to the URL on change.
 *
 * The `/ai` page is server-rendered with `?scope=` driving the
 * Prisma `where` clause; tabs just re-write the URL and let the
 * server component re-render. We use `router.replace` (not `push`)
 * so flipping between scopes doesn't pollute the back-button stack.
 *
 * The `null` value means "all scopes" — represented as the
 * `__all__` Tab value because Radix Tabs requires a non-empty
 * string for each trigger.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { aiScopeEnum, type AIScope } from '@/lib/schemas/ai';

const ALL_VALUE = '__all__';

const ORDER: ReadonlyArray<{ value: AIScope; label: string }> = [
  { value: 'ads', label: 'Ads' },
  { value: 'social', label: 'Social' },
  { value: 'leads', label: 'Leads' },
  { value: 'overall', label: 'Overall' },
];

export interface ScopeTabsProps {
  /** `null` = "All scopes". */
  currentScope: AIScope | null;
}

export function ScopeTabs({ currentScope }: ScopeTabsProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const value = currentScope ?? ALL_VALUE;

  const handleChange = React.useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams?.toString() ?? '');
      // Reset pagination whenever the filter changes — a page-2
      // bookmark for one scope rarely makes sense for another.
      params.delete('page');

      if (next === ALL_VALUE) {
        params.delete('scope');
      } else {
        const parsed = aiScopeEnum.safeParse(next);
        if (!parsed.success) {
          params.delete('scope');
        } else {
          params.set('scope', parsed.data);
        }
      }

      const qs = params.toString();
      router.replace(qs ? `/ai?${qs}` : '/ai', { scroll: false });
    },
    [router, searchParams],
  );

  return (
    <Tabs value={value} onValueChange={handleChange} className="w-full">
      <TabsList
        className="flex w-full flex-wrap justify-start gap-1 sm:w-auto"
        aria-label="Filter insights by scope"
      >
        <TabsTrigger value={ALL_VALUE}>All</TabsTrigger>
        {ORDER.map((s) => (
          <TabsTrigger key={s.value} value={s.value}>
            {s.label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
