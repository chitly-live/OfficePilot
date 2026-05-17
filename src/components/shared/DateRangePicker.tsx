'use client';

/**
 * DateRangePicker — pop-over range picker built on the existing
 * shadcn `Calendar` (which wraps `react-day-picker`).
 *
 * Used on the AI Analysis filter (SPEC §10.2 — "filter by scope and
 * time window") and the various campaign / report pages. Two-step
 * UX:
 *
 *   1. User clicks the trigger button → opens a `Popover` with a
 *      two-month inline calendar (`numberOfMonths={2}`) so they can
 *      see the start + end month at once.
 *   2. They click the start day, then the end day. The selection
 *      bubbles up via `onChange` as soon as both ends are set.
 *
 * Controlled API: caller owns the `value: DateRange | undefined`
 * state. Returning `undefined` from `onChange` clears the selection;
 * returning a partial range (`from` only) is also valid while the
 * user is mid-pick.
 *
 * Date formatting uses `date-fns` (already a project dep), defaulting
 * to short ISO-ish "MMM d, yyyy" so the trigger label fits on one
 * line in dense table toolbars.
 */

import * as React from 'react';
import { format } from 'date-fns';
import { CalendarIcon, X } from 'lucide-react';
import type { DateRange } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

// Re-export so consumers don't have to import from `react-day-picker`
// directly.
export type { DateRange } from 'react-day-picker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DateRangePickerProps {
  /** Current selection. `undefined` = no range chosen. */
  value: DateRange | undefined;
  /** Selection-change handler. */
  onChange: (range: DateRange | undefined) => void;
  /**
   * Placeholder shown on the trigger when no range is selected.
   * @default 'Pick a date range'
   */
  placeholder?: string;
  /** Optional accessible label for the trigger button. */
  ariaLabel?: string;
  /**
   * `date-fns` format pattern for the rendered range label.
   * @default 'MMM d, yyyy'
   */
  formatPattern?: string;
  /** When true, hide the inline clear (×) button on the trigger. */
  hideClearButton?: boolean;
  /** Disable the trigger entirely. */
  disabled?: boolean;
  /** Min selectable date (passed through to react-day-picker). */
  fromDate?: Date;
  /** Max selectable date. */
  toDate?: Date;
  /** Number of months to show side-by-side. @default 2 */
  numberOfMonths?: number;
  /** Extra classes on the trigger. */
  className?: string;
  /** Optional name (useful when embedding inside an HTML form). */
  name?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the trigger label. Three states:
 *   • neither end set → placeholder
 *   • only `from` set → "Apr 4, 2026 – …"
 *   • both ends set   → "Apr 4, 2026 – Apr 18, 2026"
 */
function formatRange(
  range: DateRange | undefined,
  pattern: string,
  placeholder: string,
): string {
  if (!range?.from) return placeholder;
  const fromLabel = format(range.from, pattern);
  if (!range.to) return `${fromLabel} – …`;
  return `${fromLabel} – ${format(range.to, pattern)}`;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** See file-level JSDoc. */
export function DateRangePicker({
  value,
  onChange,
  placeholder = 'Pick a date range',
  ariaLabel,
  formatPattern = 'MMM d, yyyy',
  hideClearButton = false,
  disabled = false,
  fromDate,
  toDate,
  numberOfMonths = 2,
  className,
  name,
}: DateRangePickerProps) {
  const [open, setOpen] = React.useState(false);

  const triggerLabel = formatRange(value, formatPattern, placeholder);
  const hasSelection = Boolean(value?.from);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={ariaLabel ?? 'Select date range'}
          className={cn(
            'min-w-[220px] justify-start text-left font-normal',
            !hasSelection && 'text-muted-foreground',
            className,
          )}
          data-name={name}
        >
          <CalendarIcon className="h-4 w-4" aria-hidden="true" />
          <span className="flex-1 truncate">{triggerLabel}</span>
          {hasSelection && !hideClearButton ? (
            // Inline clear control. Stops propagation so the click
            // doesn't also toggle the popover open.
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear date range"
              className="ml-1 inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onChange(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  event.stopPropagation();
                  onChange(undefined);
                }
              }}
            >
              <X className="h-3 w-3" aria-hidden="true" />
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          selected={value}
          onSelect={onChange}
          numberOfMonths={numberOfMonths}
          defaultMonth={value?.from}
          // `react-day-picker` 10's range mode honours min/max via
          // matcher props; we wire the most common ones through.
          disabled={
            fromDate || toDate
              ? [
                  ...(fromDate ? [{ before: fromDate }] : []),
                  ...(toDate ? [{ after: toDate }] : []),
                ]
              : undefined
          }
        />
      </PopoverContent>
    </Popover>
  );
}
