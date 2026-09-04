'use client';

/**
 * Filter bar for `/finance/transactions`. Every control writes to the
 * URL (`router.replace`) so the server page re-queries; nothing is held
 * in client state except the debounced search text.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, X } from 'lucide-react';
import type {
  FinanceAccountType,
  FinanceCategory,
  FinancePartyType,
} from '@prisma/client';

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
import {
  ALL_FINANCE_CATEGORIES,
  FINANCE_CATEGORY_META,
  FINANCE_PARTY_TYPE_SHORT,
} from '@/lib/finance';

import { ALL_MONTHS, NONE_VALUE } from '../finance-ui';

const ALL = '__all__';
const TEXT_DEBOUNCE_MS = 300;

export interface FilterPartyOption {
  id: string;
  name: string;
  type: FinancePartyType;
}

export interface FilterAccountOption {
  id: string;
  name: string;
  type: FinanceAccountType;
}

export interface TransactionsFiltersProps {
  /** `'YYYY-MM'` or `'all'`. */
  defaultMonth: string;
  defaultDirection: string;
  defaultCategory: string;
  defaultPartyId: string;
  defaultAccountId: string;
  defaultSearch: string;
  parties: FilterPartyOption[];
  accounts: FilterAccountOption[];
}

export function TransactionsFilters({
  defaultMonth,
  defaultDirection,
  defaultCategory,
  defaultPartyId,
  defaultAccountId,
  defaultSearch,
  parties,
  accounts,
}: TransactionsFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [searchValue, setSearchValue] = React.useState(defaultSearch);

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
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `/finance/transactions?${qs}` : '/finance/transactions', {
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

  const hasAnyFilter =
    Boolean(defaultSearch) ||
    Boolean(defaultDirection) ||
    Boolean(defaultCategory) ||
    Boolean(defaultPartyId) ||
    Boolean(defaultAccountId) ||
    defaultMonth === ALL_MONTHS;

  const isAllMonths = defaultMonth === ALL_MONTHS;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <Label htmlFor="finance-search" className="sr-only">
            Search transactions
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="finance-search"
            type="search"
            placeholder="Search description, reference, or party…"
            autoComplete="off"
            className="pl-9"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="finance-month" className="text-xs">
            Month
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="finance-month"
              type="month"
              className="w-full sm:w-44"
              value={isAllMonths ? '' : defaultMonth}
              onChange={(e) =>
                pushFilter({ month: e.target.value || undefined })
              }
            />
            <Button
              type="button"
              variant={isAllMonths ? 'default' : 'outline'}
              size="sm"
              onClick={() => pushFilter({ month: isAllMonths ? undefined : ALL_MONTHS })}
              title="Show every month"
            >
              All time
            </Button>
          </div>
        </div>

        {hasAnyFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchValue('');
              router.replace('/finance/transactions', { scroll: false });
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span>Clear all</span>
          </Button>
        ) : null}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="finance-direction" className="text-xs">
            Type
          </Label>
          <Select
            value={defaultDirection === '' ? ALL : defaultDirection}
            onValueChange={(v) => pushFilter({ direction: v === ALL ? undefined : v })}
          >
            <SelectTrigger id="finance-direction" className="w-full sm:w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>In & out</SelectItem>
              <SelectItem value="IN">Money in</SelectItem>
              <SelectItem value="OUT">Money out</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="finance-category" className="text-xs">
            Category
          </Label>
          <Select
            value={defaultCategory === '' ? ALL : defaultCategory}
            onValueChange={(v) => pushFilter({ category: v === ALL ? undefined : v })}
          >
            <SelectTrigger id="finance-category" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All categories</SelectItem>
              {ALL_FINANCE_CATEGORIES.filter(
                (c) =>
                  defaultDirection === '' ||
                  FINANCE_CATEGORY_META[c].direction === defaultDirection,
              ).map((c: FinanceCategory) => (
                <SelectItem key={c} value={c}>
                  {FINANCE_CATEGORY_META[c].direction === 'IN' ? 'In · ' : 'Out · '}
                  {FINANCE_CATEGORY_META[c].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="finance-party" className="text-xs">
            Party
          </Label>
          <Select
            value={defaultPartyId === '' ? ALL : defaultPartyId}
            onValueChange={(v) => pushFilter({ partyId: v === ALL ? undefined : v })}
          >
            <SelectTrigger id="finance-party" className="w-full sm:w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All parties</SelectItem>
              {parties.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  <span className="ml-1 text-xs text-muted-foreground">
                    · {FINANCE_PARTY_TYPE_SHORT[p.type]}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="finance-account" className="text-xs">
            Account
          </Label>
          <Select
            value={defaultAccountId === '' ? ALL : defaultAccountId}
            onValueChange={(v) => pushFilter({ accountId: v === ALL ? undefined : v })}
          >
            <SelectTrigger id="finance-account" className="w-full sm:w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All accounts</SelectItem>
              {accounts.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {/* NONE_VALUE is exported for forms; referenced here so the shared
          helper module stays the single place that defines sentinels. */}
      <span className="sr-only">{NONE_VALUE}</span>
    </div>
  );
}
