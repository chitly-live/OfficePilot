'use client';

/**
 * Search + status + holder filter for `/finance/assets`.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search } from 'lucide-react';
import { AssetStatus } from '@prisma/client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ASSET_STATUS_LABELS } from '@/lib/assets';

const ALL = '__all__';
const TEXT_DEBOUNCE_MS = 300;

export interface AssetsFiltersProps {
  defaultSearch: string;
  defaultStatus: string;
  defaultHolder: string;
  holders: { value: string; label: string }[];
}

export function AssetsFilters({ defaultSearch, defaultStatus, defaultHolder, holders }: AssetsFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = React.useState(defaultSearch);

  const pushFilter = React.useCallback(
    (overrides: Record<string, string | undefined>) => {
      const next = new URLSearchParams(searchParams?.toString() ?? '');
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }
      next.delete('transaction');
      const qs = next.toString();
      router.replace(qs ? `/finance/assets?${qs}` : '/finance/assets', { scroll: false });
    },
    [router, searchParams],
  );

  React.useEffect(() => {
    const trimmed = searchValue.trim();
    if (trimmed === (searchParams?.get('search') ?? '')) return;
    const handle = window.setTimeout(() => pushFilter({ search: trimmed || undefined }), TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchValue, searchParams, pushFilter]);

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="relative flex-1">
        <Label htmlFor="assets-search" className="sr-only">
          Search assets
        </Label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="assets-search"
          type="search"
          placeholder="Search by name, serial or category…"
          autoComplete="off"
          className="pl-9"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="assets-status" className="text-xs">
          Status
        </Label>
        <Select
          value={defaultStatus || ALL}
          onValueChange={(v) => pushFilter({ status: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="assets-status" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All</SelectItem>
            {Object.values(AssetStatus).map((s) => (
              <SelectItem key={s} value={s}>
                {ASSET_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="assets-holder" className="text-xs">
          With
        </Label>
        <Select
          value={defaultHolder || ALL}
          onValueChange={(v) => pushFilter({ holder: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="assets-holder" className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={ALL}>Anyone</SelectItem>
            {holders.map((h) => (
              <SelectItem key={h.value} value={h.value}>
                {h.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
