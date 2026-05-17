'use client';

/**
 * SocialFilters — URL-driven filter bar for `/social`.
 *
 * Controls (all push to `searchParams`, page resets to 1 on change):
 *
 *   • search        — debounced free-text on caption
 *   • platform      — multi (INSTAGRAM · FACEBOOK · TWITTER · LINKEDIN
 *                            · YOUTUBE · THREADS)
 *   • status        — multi (DRAFT · SCHEDULED · PUBLISHED · FAILED)
 *   • ownerId       — single (loaded server-side from active Users)
 *   • dateFrom/To   — scheduledAt range (YYYY-MM-DD)
 *   • sortBy        — single (created · updated · scheduled · published
 *                              · engagement)
 *   • view          — calendar · list (held in URL; this component
 *                     just preserves the value when other filters
 *                     change)
 *
 * Multi-value filters are persisted as a comma-joined string in the
 * URL (`?status=DRAFT,SCHEDULED`) — same convention
 * `socialPostListQuerySchema` accepts. Mirrors the marketing filter
 * UX in `src/app/(app)/marketing/marketing-filters.tsx`.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Search, X } from 'lucide-react';
import { PostStatus, SocialPlatform } from '@prisma/client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { SOCIAL_SORT_KEYS, type SocialSortKey } from '@/lib/schemas/social';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the free-text search input. */
const TEXT_DEBOUNCE_MS = 300;

/** Sentinel "all owners" option — shadcn `Select` rejects '' as item value. */
const OWNER_ALL = '__all__';

/** Friendly label for each PostStatus. */
const STATUS_LABELS: Record<PostStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
};

/** Friendly label for each SocialPlatform. */
const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

/** Friendly label for each `sortBy` value. */
const SORT_LABELS: Record<SocialSortKey, string> = {
  created: 'Newest first',
  updated: 'Recently updated',
  scheduled: 'Scheduled date',
  published: 'Published date',
  engagement: 'Engagement',
};

const STATUS_VALUES = Object.keys(STATUS_LABELS) as PostStatus[];
const PLATFORM_VALUES = Object.keys(PLATFORM_LABELS) as SocialPlatform[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnerOption {
  id: string;
  label: string;
}

export interface SocialFiltersProps {
  defaultSearch: string;
  defaultPlatform: SocialPlatform[];
  defaultStatus: PostStatus[];
  defaultOwnerId: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateFrom: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateTo: string;
  defaultSortBy: SocialSortKey;
  ownerOptions: OwnerOption[];
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SocialFilters({
  defaultSearch,
  defaultPlatform,
  defaultStatus,
  defaultOwnerId,
  defaultDateFrom,
  defaultDateTo,
  defaultSortBy,
  ownerOptions,
}: SocialFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Local debounce state for the search input.
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
      next.delete('page');
      const qs = next.toString();
      router.replace(qs ? `/social?${qs}` : '/social', {
        scroll: false,
      });
    },
    [router, searchParams],
  );

  // Debounce the search input. Only push when the value actually
  // changed from what's already in the URL.
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
    defaultPlatform.length > 0 ||
    defaultStatus.length > 0 ||
    Boolean(defaultOwnerId) ||
    Boolean(defaultDateFrom) ||
    Boolean(defaultDateTo) ||
    defaultSortBy !== 'created';

  const handleClearAll = () => {
    setSearchValue('');
    // Preserve the `view` param so a user clearing filters doesn't
    // also lose their calendar/list preference.
    const next = new URLSearchParams();
    const view = searchParams?.get('view');
    if (view) next.set('view', view);
    const qs = next.toString();
    router.replace(qs ? `/social?${qs}` : '/social', { scroll: false });
  };

  return (
    <div className="space-y-3">
      {/* Row 1: search + owner + sort + clear. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <Label htmlFor="social-search" className="sr-only">
            Search posts
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="social-search"
            type="search"
            placeholder="Search posts by caption…"
            autoComplete="off"
            className="pl-9"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="social-owner" className="text-xs">
            Owner
          </Label>
          <Select
            value={defaultOwnerId === '' ? OWNER_ALL : defaultOwnerId}
            onValueChange={(value) =>
              pushFilter({
                ownerId: value === OWNER_ALL ? undefined : value,
              })
            }
          >
            <SelectTrigger
              id="social-owner"
              className="w-full sm:w-56"
              aria-label="Filter by owner"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OWNER_ALL}>All owners</SelectItem>
              {ownerOptions.map((owner) => (
                <SelectItem key={owner.id} value={owner.id}>
                  {owner.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="social-sort" className="text-xs">
            Sort by
          </Label>
          <Select
            value={defaultSortBy}
            onValueChange={(value) =>
              pushFilter({
                sortBy: value === 'created' ? undefined : value,
              })
            }
          >
            <SelectTrigger
              id="social-sort"
              className="w-full sm:w-44"
              aria-label="Sort posts"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOCIAL_SORT_KEYS.map((key) => (
                <SelectItem key={key} value={key}>
                  {SORT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {hasAnyFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleClearAll}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span>Clear all</span>
          </Button>
        ) : null}
      </div>

      {/* Row 2: enum multi-selects + date range. */}
      <div className="flex flex-wrap gap-3">
        <MultiSelectFilter
          label="Platform"
          ariaLabel="Filter by platform"
          values={PLATFORM_VALUES}
          labels={PLATFORM_LABELS}
          selected={defaultPlatform}
          onChange={(next) =>
            pushFilter({
              platform: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />
        <MultiSelectFilter
          label="Status"
          ariaLabel="Filter by status"
          values={STATUS_VALUES}
          labels={STATUS_LABELS}
          selected={defaultStatus}
          onChange={(next) =>
            pushFilter({
              status: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />

        <div className="flex flex-col gap-1">
          <Label htmlFor="social-date-from" className="text-xs">
            Scheduled from
          </Label>
          <Input
            id="social-date-from"
            type="date"
            className="w-full sm:w-44"
            defaultValue={defaultDateFrom}
            onChange={(e) =>
              pushFilter({ dateFrom: e.target.value || undefined })
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="social-date-to" className="text-xs">
            Scheduled to
          </Label>
          <Input
            id="social-date-to"
            type="date"
            className="w-full sm:w-44"
            defaultValue={defaultDateTo}
            onChange={(e) =>
              pushFilter({ dateTo: e.target.value || undefined })
            }
          />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MultiSelectFilter — small popover-driven checkbox list
// ---------------------------------------------------------------------------

/**
 * Generic multi-checkbox popover for an enum. Local state holds the
 * draft selection; we push the URL only when the popover closes so a
 * user picking three platforms doesn't trigger three reloads.
 */
function MultiSelectFilter<TValue extends string>({
  label,
  ariaLabel,
  values,
  labels,
  selected,
  onChange,
}: {
  label: string;
  ariaLabel: string;
  values: readonly TValue[];
  labels: Record<TValue, string>;
  selected: TValue[];
  onChange: (next: TValue[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<TValue[]>(selected);

  // Re-sync the draft when the parent's selection changes.
  React.useEffect(() => {
    setDraft(selected);
  }, [selected]);

  /** Apply the draft to the URL when the popover closes. */
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      const same =
        draft.length === selected.length &&
        draft.every((v) => selected.includes(v));
      if (!same) onChange(draft);
    }
  };

  const summary =
    selected.length === 0
      ? `All ${label.toLowerCase()}`
      : selected.length === 1
        ? labels[selected[0]!]
        : `${selected.length} selected`;

  return (
    <div className="flex flex-col gap-1">
      <Label className="text-xs">{label}</Label>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="default"
            className={cn(
              'h-10 w-full justify-between sm:w-48',
              selected.length === 0 && 'text-muted-foreground',
            )}
            aria-label={ariaLabel}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className="h-4 w-4 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-60 p-2">
          <div className="space-y-1">
            {values.map((v) => {
              const checked = draft.includes(v);
              const id = `social-filter-${label.toLowerCase()}-${v}`;
              return (
                <label
                  key={v}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(next) => {
                      if (next === true) {
                        setDraft((prev) =>
                          prev.includes(v) ? prev : [...prev, v],
                        );
                      } else {
                        setDraft((prev) => prev.filter((p) => p !== v));
                      }
                    }}
                  />
                  <span>{labels[v]}</span>
                </label>
              );
            })}
          </div>
          {draft.length > 0 ? (
            <div className="mt-2 flex justify-end border-t pt-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setDraft([])}
              >
                Clear
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
