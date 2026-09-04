'use client';

/**
 * Search + type + active filter for `/finance/parties`.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  ALL_FINANCE_PARTY_TYPES,
  FINANCE_PARTY_TYPE_SHORT,
} from '@/lib/finance';

const ALL = '__all__';
const TEXT_DEBOUNCE_MS = 300;

export interface PartiesFiltersProps {
  defaultSearch: string;
  defaultType: string;
  showInactive: boolean;
}

export function PartiesFilters({
  defaultSearch,
  defaultType,
  showInactive,
}: PartiesFiltersProps) {
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
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `/finance/parties?${qs}` : '/finance/parties', {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  React.useEffect(() => {
    const trimmed = searchValue.trim();
    const current = searchParams?.get('search') ?? '';
    if (trimmed === current) return;
    const handle = window.setTimeout(() => {
      pushFilter({ search: trimmed === '' ? undefined : trimmed });
    }, TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchValue, searchParams, pushFilter]);

  const hasAnyFilter = Boolean(defaultSearch) || Boolean(defaultType) || showInactive;

  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="relative flex-1">
        <Label htmlFor="parties-search" className="sr-only">
          Search parties
        </Label>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          id="parties-search"
          type="search"
          placeholder="Search by name, phone, or email…"
          autoComplete="off"
          className="pl-9"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="parties-type" className="text-xs">
          Type
        </Label>
        <Select
          value={defaultType === '' ? ALL : defaultType}
          onValueChange={(v) => pushFilter({ type: v === ALL ? undefined : v })}
        >
          <SelectTrigger id="parties-type" className="w-full sm:w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All types</SelectItem>
            {ALL_FINANCE_PARTY_TYPES.map((t) => (
              <SelectItem key={t} value={t}>
                {FINANCE_PARTY_TYPE_SHORT[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="parties-inactive" className="text-xs">
          Show inactive
        </Label>
        <div className="flex h-10 items-center">
          <Switch
            id="parties-inactive"
            checked={showInactive}
            onCheckedChange={(checked) =>
              pushFilter({ inactive: checked ? '1' : undefined })
            }
          />
        </div>
      </div>

      {hasAnyFilter ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearchValue('');
            router.replace('/finance/parties', { scroll: false });
          }}
        >
          <X className="h-4 w-4" aria-hidden="true" />
          <span>Clear</span>
        </Button>
      ) : null}
    </div>
  );
}
