'use client';

/**
 * MarketingFilters — URL-driven filter bar for `/marketing`.
 *
 * Controls (all push to `searchParams`, page resets to 1 on change):
 *
 *   • search        — debounced free-text on campaign name
 *   • status        — multi (DRAFT · ACTIVE · PAUSED · ENDED)
 *   • channel       — multi (META_ADS · GOOGLE_ADS · INSTAGRAM_ORGANIC
 *                            · YOUTUBE · INFLUENCER · EMAIL · OTHER)
 *   • ownerId       — single (loaded server-side from active Users)
 *   • dateFrom/To   — startDate range (YYYY-MM-DD)
 *   • sortBy        — single (created · updated · startDate · budget
 *                              · spent · conversions)
 *
 * Multi-value filters are persisted as a comma-joined string in the
 * URL (`?status=DRAFT,ACTIVE`) — same convention
 * `campaignListQuerySchema` accepts. Mirrors the Leads filter UX in
 * `src/app/(app)/leads/leads-filters.tsx`.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Search, X } from 'lucide-react';
import { CampaignChannel, CampaignStatus } from '@prisma/client';

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
import { CAMPAIGN_SORT_KEYS, type CampaignSortKey } from '@/lib/schemas/campaigns';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the free-text search input. */
const TEXT_DEBOUNCE_MS = 300;

/** Sentinel "all owners" option — shadcn `Select` rejects '' as item value. */
const OWNER_ALL = '__all__';

/** Friendly label for each CampaignStatus. */
const STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ENDED: 'Ended',
};

/** Friendly label for each CampaignChannel. */
const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  INSTAGRAM_ORGANIC: 'Instagram Organic',
  YOUTUBE: 'YouTube',
  INFLUENCER: 'Influencer',
  EMAIL: 'Email',
  OTHER: 'Other',
};

/** Friendly label for each `sortBy` value. */
const SORT_LABELS: Record<CampaignSortKey, string> = {
  created: 'Newest first',
  updated: 'Recently updated',
  startDate: 'Start date',
  budget: 'Budget',
  spent: 'Spend',
  conversions: 'Conversions',
};

const STATUS_VALUES = Object.keys(STATUS_LABELS) as CampaignStatus[];
const CHANNEL_VALUES = Object.keys(CHANNEL_LABELS) as CampaignChannel[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnerOption {
  id: string;
  label: string;
}

export interface MarketingFiltersProps {
  defaultSearch: string;
  defaultStatus: CampaignStatus[];
  defaultChannel: CampaignChannel[];
  defaultOwnerId: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateFrom: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateTo: string;
  defaultSortBy: CampaignSortKey;
  ownerOptions: OwnerOption[];
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function MarketingFilters({
  defaultSearch,
  defaultStatus,
  defaultChannel,
  defaultOwnerId,
  defaultDateFrom,
  defaultDateTo,
  defaultSortBy,
  ownerOptions,
}: MarketingFiltersProps) {
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
      router.replace(qs ? `/marketing?${qs}` : '/marketing', {
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
    defaultStatus.length > 0 ||
    defaultChannel.length > 0 ||
    Boolean(defaultOwnerId) ||
    Boolean(defaultDateFrom) ||
    Boolean(defaultDateTo) ||
    defaultSortBy !== 'created';

  return (
    <div className="space-y-3">
      {/* Row 1: search + owner + sort + clear. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <Label htmlFor="campaigns-search" className="sr-only">
            Search campaigns
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="campaigns-search"
            type="search"
            placeholder="Search campaigns by name…"
            autoComplete="off"
            className="pl-9"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="campaigns-owner" className="text-xs">
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
              id="campaigns-owner"
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
          <Label htmlFor="campaigns-sort" className="text-xs">
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
              id="campaigns-sort"
              className="w-full sm:w-44"
              aria-label="Sort campaigns"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CAMPAIGN_SORT_KEYS.map((key) => (
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
            onClick={() => {
              setSearchValue('');
              router.replace('/marketing', { scroll: false });
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span>Clear all</span>
          </Button>
        ) : null}
      </div>

      {/* Row 2: enum multi-selects + date range. */}
      <div className="flex flex-wrap gap-3">
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
        <MultiSelectFilter
          label="Channel"
          ariaLabel="Filter by channel"
          values={CHANNEL_VALUES}
          labels={CHANNEL_LABELS}
          selected={defaultChannel}
          onChange={(next) =>
            pushFilter({
              channel: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />

        <div className="flex flex-col gap-1">
          <Label htmlFor="campaigns-date-from" className="text-xs">
            Start from
          </Label>
          <Input
            id="campaigns-date-from"
            type="date"
            className="w-full sm:w-44"
            defaultValue={defaultDateFrom}
            onChange={(e) =>
              pushFilter({ dateFrom: e.target.value || undefined })
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="campaigns-date-to" className="text-xs">
            Start to
          </Label>
          <Input
            id="campaigns-date-to"
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
 * user picking three statuses doesn't trigger three table reloads.
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
              const id = `filter-${label.toLowerCase()}-${v}`;
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
