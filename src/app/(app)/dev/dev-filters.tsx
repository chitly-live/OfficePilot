'use client';

/**
 * DevFilters — URL-driven filter bar for `/dev` and the bug/release
 * sub-views.
 *
 * Controls (all push to `searchParams`, page resets to 1 on change):
 *
 *   • search        — debounced free-text (title/description)
 *   • type          — multi (FEATURE · BUG · CHORE · RELEASE)
 *   • status        — multi (TODO · DOING · DONE)
 *   • priority      — multi (LOW · MEDIUM · HIGH · URGENT)
 *   • assigneeId    — single (loaded server-side from active Users)
 *
 * The `type` filter is suppressed on `/dev/bugs` and `/dev/releases`
 * (those pages are scoped to a fixed type) — the parent page passes
 * `hideType={true}` to hide it.
 *
 * Multi-value filters serialise to comma-joined strings in the URL
 * (`?status=TODO,DOING`) — same convention `devTaskListQuerySchema`
 * accepts. Mirrors the leads filter UX so the two surfaces feel
 * identical.
 */

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ChevronDown, Search, X } from 'lucide-react';
import { DevTaskStatus, DevTaskType, Priority } from '@prisma/client';

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce window for the free-text search input. */
const TEXT_DEBOUNCE_MS = 300;

/** Sentinel for the "all assignees" choice — shadcn `Select` rejects
 *  an empty string item value. */
const ASSIGNEE_ALL = '__all__';
/** Sentinel for the "unassigned only" choice. */
const ASSIGNEE_UNASSIGNED = '__unassigned__';

const TYPE_LABELS: Record<DevTaskType, string> = {
  FEATURE: 'Feature',
  BUG: 'Bug',
  CHORE: 'Chore',
  RELEASE: 'Release',
};
const STATUS_LABELS: Record<DevTaskStatus, string> = {
  TODO: 'To do',
  DOING: 'Doing',
  DONE: 'Done',
};
const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const TYPE_VALUES = Object.keys(TYPE_LABELS) as DevTaskType[];
const STATUS_VALUES = Object.keys(STATUS_LABELS) as DevTaskStatus[];
const PRIORITY_VALUES = Object.keys(PRIORITY_LABELS) as Priority[];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AssigneeOption {
  id: string;
  label: string;
}

export interface DevFiltersProps {
  defaultSearch: string;
  defaultType: DevTaskType[];
  defaultStatus: DevTaskStatus[];
  defaultPriority: Priority[];
  /** "" → all, "__unassigned__" → unassigned only, otherwise a user id. */
  defaultAssigneeId: string;
  assigneeOptions: AssigneeOption[];
  /** When true, hide the "Type" multi-select (used on /dev/bugs and
   *  /dev/releases where the type is implicit). */
  hideType?: boolean;
  /** When true, hide the "Status" multi-select (rare — currently used
   *  on /dev/releases where status filtering isn't useful). */
  hideStatus?: boolean;
  /** Base path (e.g. `/dev`, `/dev/bugs`, `/dev/releases`). Determines
   *  where the filter pushes navigate to. */
  basePath: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function DevFilters({
  defaultSearch,
  defaultType,
  defaultStatus,
  defaultPriority,
  defaultAssigneeId,
  assigneeOptions,
  hideType = false,
  hideStatus = false,
  basePath,
}: DevFiltersProps) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Locally-controlled text input so we can debounce.
  const [searchValue, setSearchValue] = React.useState(defaultSearch);

  /**
   * Build a fresh URL from the current params with the given
   * overrides. `undefined`/`''` means "remove this key". `page` is
   * always reset on filter change.
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
      router.replace(qs ? `${basePath}?${qs}` : basePath, {
        scroll: false,
      });
    },
    [router, searchParams, basePath],
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
    defaultType.length > 0 ||
    defaultStatus.length > 0 ||
    defaultPriority.length > 0 ||
    Boolean(defaultAssigneeId);

  // Resolve the assignee select value — translate "" to the
  // sentinel since the Select can't render empty-string items.
  const assigneeValue =
    defaultAssigneeId === '' ? ASSIGNEE_ALL : defaultAssigneeId;

  return (
    <div className="space-y-3">
      {/* Row 1: search + clear. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="relative flex-1">
          <Label htmlFor="dev-search" className="sr-only">
            Search dev tasks
          </Label>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            id="dev-search"
            type="search"
            placeholder="Search by title or description…"
            autoComplete="off"
            className="pl-9"
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
          />
        </div>

        {hasAnyFilter ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearchValue('');
              router.replace(basePath, { scroll: false });
            }}
          >
            <X className="h-4 w-4" aria-hidden="true" />
            <span>Clear all</span>
          </Button>
        ) : null}
      </div>

      {/* Row 2: enum multi-selects + assignee. */}
      <div className="flex flex-wrap gap-3">
        {hideType ? null : (
          <MultiSelectFilter
            label="Type"
            ariaLabel="Filter by type"
            values={TYPE_VALUES}
            labels={TYPE_LABELS}
            selected={defaultType}
            onChange={(next) =>
              pushFilter({
                type: next.length > 0 ? next.join(',') : undefined,
              })
            }
          />
        )}
        {hideStatus ? null : (
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
        )}
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
          <Label htmlFor="dev-assignee" className="text-xs">
            Assignee
          </Label>
          <Select
            value={assigneeValue}
            onValueChange={(value) => {
              if (value === ASSIGNEE_ALL) {
                pushFilter({ assigneeId: undefined });
              } else {
                pushFilter({ assigneeId: value });
              }
            }}
          >
            <SelectTrigger
              id="dev-assignee"
              className="w-full sm:w-56"
              aria-label="Filter by assignee"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ASSIGNEE_ALL}>All assignees</SelectItem>
              <SelectItem value={ASSIGNEE_UNASSIGNED}>Unassigned</SelectItem>
              {assigneeOptions.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
 * user picking three statuses doesn't trigger three page reloads.
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
