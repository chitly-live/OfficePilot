'use client';

/**
 * LeadsFilters — URL-driven filter bar for `/leads`.
 *
 * Controls (all push to `searchParams`, page resets to 1 on change):
 *
 *   • search        — debounced free-text (name/email/phone/company)
 *   • status        — multi (NEW · CONTACTED · INTERESTED · FOLLOW_UP
 *                     · CONVERTED · LOST)
 *   • source        — multi (WEBSITE · WHATSAPP · FACEBOOK_AD ·
 *                     GOOGLE_AD · INSTAGRAM · REFERRAL · MANUAL ·
 *                     OTHER)
 *   • priority      — multi (LOW · MEDIUM · HIGH · URGENT)
 *   • ownerId       — single (loaded server-side from active Users)
 *   • tag           — single tag substring match
 *   • dateFrom/To   — created-at range (YYYY-MM-DD)
 *
 * Multi-value filters are persisted as a comma-joined string in the
 * URL (`?status=NEW,CONTACTED`) — same convention `leadListQuerySchema`
 * accepts. We build a tiny multi-checkbox popover for each so users
 * can pick subsets without a full table re-render between clicks.
 *
 * Why a client component?
 *   • `useSearchParams` + `useRouter` are client-only hooks.
 *   • Debouncing the search input + holding the unsubmitted multi-
 *     selects in local state requires React state.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Search, X } from 'lucide-react';
import { LeadSource, LeadStatus, Priority } from '@prisma/client';

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
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the free-text inputs (search + tag). */
const TEXT_DEBOUNCE_MS = 300;

/** Sentinel option value for the "all owners" choice. shadcn `Select`
 *  rejects empty string as an item value, so we use a sentinel and
 *  translate it to "no filter" before pushing to the URL. */
const OWNER_ALL = '__all__';

/** Sentinel value for the "all phone types" choice (same Select
 *  empty-string limitation as the owner select). */
const PHONE_TYPE_ALL = '__all__';

/**
 * Phone-type filter options. v0.1.4 — the spreadsheet only tracks
 * iPhone / Android / Other, with `null` meaning "not yet captured".
 * We surface that as a distinct "Unknown" choice so admins can
 * triage rows missing the field.
 */
const PHONE_TYPE_VALUES = ['iPhone', 'Android', 'Other', 'Unknown'] as const;

/** Friendly label for each LeadStatus. */
const STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  FOLLOW_UP: 'Follow up',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

/** Friendly label for each LeadSource. */
const SOURCE_LABELS: Record<LeadSource, string> = {
  WEBSITE: 'Website',
  WHATSAPP: 'WhatsApp',
  FACEBOOK_AD: 'Facebook Ad',
  GOOGLE_AD: 'Google Ad',
  INSTAGRAM: 'Instagram',
  REFERRAL: 'Referral',
  MANUAL: 'Manual',
  OTHER: 'Other',
};

/** Friendly label for each Priority. */
const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const STATUS_VALUES = Object.keys(STATUS_LABELS) as LeadStatus[];
const SOURCE_VALUES = Object.keys(SOURCE_LABELS) as LeadSource[];
const PRIORITY_VALUES = Object.keys(PRIORITY_LABELS) as Priority[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OwnerOption {
  id: string;
  label: string;
}

export interface LeadsFiltersProps {
  defaultSearch: string;
  defaultStatus: LeadStatus[];
  defaultSource: LeadSource[];
  defaultPriority: Priority[];
  defaultOwnerId: string;
  defaultTag: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateFrom: string;
  /** YYYY-MM-DD or empty string. */
  defaultDateTo: string;
  ownerOptions: OwnerOption[];
  /** v0.1.4 — currently selected phone-type filter; `''` = no filter. */
  defaultPhoneType?: string;
  /** v0.1.4 — currently selected languages (multi). */
  defaultLanguages?: string[];
  /** v0.1.4 — distinct language values across the tenant for the
   *  multi-select picker. */
  languageOptions?: string[];
  /** v0.1.4 — when true, only show leads marked `notOnWhatsapp`. */
  defaultNotOnWhatsapp?: boolean;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function LeadsFilters({
  defaultSearch,
  defaultStatus,
  defaultSource,
  defaultPriority,
  defaultOwnerId,
  defaultTag,
  defaultDateFrom,
  defaultDateTo,
  ownerOptions,
  defaultPhoneType = '',
  defaultLanguages = [],
  languageOptions = [],
  defaultNotOnWhatsapp = false,
}: LeadsFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Locally-controlled text inputs so we can debounce.
  const [searchValue, setSearchValue] = React.useState(defaultSearch);
  const [tagValue, setTagValue] = React.useState(defaultTag);

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
      router.replace(qs ? `/leads?${qs}` : '/leads', { scroll: false });
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
    }, TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchValue, searchParams, pushFilter]);

  // Same pattern for the tag input.
  React.useEffect(() => {
    const trimmed = tagValue.trim();
    const current = searchParams?.get('tag') ?? '';
    if (trimmed === current) return;

    const handle = window.setTimeout(() => {
      pushFilter({ tag: trimmed === '' ? undefined : trimmed });
    }, TEXT_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [tagValue, searchParams, pushFilter]);

  // Has any filter been applied? Used to render a "Clear all" button.
  const hasAnyFilter =
    Boolean(defaultSearch) ||
    defaultStatus.length > 0 ||
    defaultSource.length > 0 ||
    defaultPriority.length > 0 ||
    Boolean(defaultOwnerId) ||
    Boolean(defaultTag) ||
    Boolean(defaultDateFrom) ||
    Boolean(defaultDateTo) ||
    Boolean(defaultPhoneType) ||
    defaultLanguages.length > 0 ||
    defaultNotOnWhatsapp;

  // Build the labels map for the language multi-select. Each option's
  // own label is its display name (no remap needed) — we still build
  // the Record so `MultiSelectFilter` can stay generic.
  const languageLabels = React.useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const v of languageOptions) map[v] = v;
    // Make sure any active selection that isn't in `languageOptions`
    // (e.g. a freshly-typed language not yet indexed) still renders.
    for (const v of defaultLanguages) if (!map[v]) map[v] = v;
    return map;
  }, [languageOptions, defaultLanguages]);

  const languageValues = React.useMemo(
    () => Object.keys(languageLabels),
    [languageLabels],
  );

  return (
    <div className="space-y-3">
      {/* Row 1: search + owner + clear. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <Label htmlFor="leads-search" className="sr-only">
            Search leads
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="leads-search"
            type="search"
            placeholder="Search by name, email, phone, or company…"
            autoComplete="off"
            className="pl-9"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-owner" className="text-xs">
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
              id="leads-owner"
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

        {hasAnyFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchValue('');
              setTagValue('');
              // Preserve the active view across a filter reset so a
              // kanban user clicking "Clear all" doesn't get bounced
              // back to the table.
              const view = searchParams?.get('view');
              const target =
                view && view !== 'table' ? `/leads?view=${view}` : '/leads';
              router.replace(target, { scroll: false });
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span>Clear all</span>
          </Button>
        ) : null}
      </div>

      {/* Row 2: enum multi-selects + tag + date range. */}
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
          label="Source"
          ariaLabel="Filter by source"
          values={SOURCE_VALUES}
          labels={SOURCE_LABELS}
          selected={defaultSource}
          onChange={(next) =>
            pushFilter({
              source: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />
        <MultiSelectFilter
          label="Priority"
          ariaLabel="Filter by priority"
          values={PRIORITY_VALUES}
          labels={PRIORITY_LABELS}
          selected={defaultPriority}
          onChange={(next) =>
            pushFilter({
              priority: next.length > 0 ? next.join(',') : undefined,
            })
          }
        />

        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-tag" className="text-xs">
            Tag
          </Label>
          <Input
            id="leads-tag"
            type="text"
            placeholder="e.g. hot"
            autoComplete="off"
            className="w-full sm:w-40"
            value={tagValue}
            onChange={(e) => setTagValue(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-date-from" className="text-xs">
            Created from
          </Label>
          <Input
            id="leads-date-from"
            type="date"
            className="w-full sm:w-44"
            defaultValue={defaultDateFrom}
            onChange={(e) =>
              pushFilter({ dateFrom: e.target.value || undefined })
            }
          />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-date-to" className="text-xs">
            Created to
          </Label>
          <Input
            id="leads-date-to"
            type="date"
            className="w-full sm:w-44"
            defaultValue={defaultDateTo}
            onChange={(e) =>
              pushFilter({ dateTo: e.target.value || undefined })
            }
          />
        </div>

        {/* v0.1.4 — Phone Type filter (single-select). */}
        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-phone-type" className="text-xs">
            Phone Type
          </Label>
          <Select
            value={defaultPhoneType === '' ? PHONE_TYPE_ALL : defaultPhoneType}
            onValueChange={(value) =>
              pushFilter({
                phoneType: value === PHONE_TYPE_ALL ? undefined : value,
              })
            }
          >
            <SelectTrigger
              id="leads-phone-type"
              className="w-full sm:w-40"
              aria-label="Filter by phone type"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PHONE_TYPE_ALL}>All phone types</SelectItem>
              {PHONE_TYPE_VALUES.map((v) => (
                <SelectItem key={v} value={v}>
                  {v}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* v0.1.4 — Language filter (multi-select chips). */}
        {languageValues.length > 0 || defaultLanguages.length > 0 ? (
          <MultiSelectFilter<string>
            label="Language"
            ariaLabel="Filter by language"
            values={languageValues}
            labels={languageLabels}
            selected={defaultLanguages}
            onChange={(next) =>
              pushFilter({
                languages: next.length > 0 ? next.join(',') : undefined,
              })
            }
          />
        ) : null}

        {/* v0.1.4 — "Not on WhatsApp" toggle. */}
        <div className="flex flex-col gap-1">
          <Label htmlFor="leads-not-whatsapp" className="text-xs">
            Not on WhatsApp
          </Label>
          <div className="flex h-10 items-center">
            <Switch
              id="leads-not-whatsapp"
              checked={defaultNotOnWhatsapp}
              onCheckedChange={(checked) =>
                pushFilter({
                  notOnWhatsapp: checked === true ? '1' : undefined,
                })
              }
              aria-label="Show only leads not on WhatsApp"
            />
          </div>
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

  // Re-sync the draft when the parent's selection changes (URL-driven).
  React.useEffect(() => {
    setDraft(selected);
  }, [selected]);

  /** Apply the draft to the URL when the popover closes. */
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      // Compare against the parent's `selected` to avoid a redundant
      // push when nothing actually changed.
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
              'h-10 w-full justify-between sm:w-44',
              selected.length === 0 && 'text-muted-foreground',
            )}
            aria-label={ariaLabel}
          >
            <span className="truncate">{summary}</span>
            <ChevronDown className="h-4 w-4 opacity-50" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-56 p-2">
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
