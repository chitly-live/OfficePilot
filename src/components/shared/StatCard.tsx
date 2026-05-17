/**
 * StatCard — single KPI card.
 *
 * Used on the dashboard "Today's pulse" row (SPEC §11.1) and the
 * module summary rows on /marketing, /social, /leads, /dev. Shows a
 * label, a big value, an optional delta indicator (up/down arrow + %)
 * and an optional slot for a sparkline / mini chart.
 *
 * Delta colors follow the SPEC §13.1 status palette:
 *   • up    → status.green
 *   • down  → status.red
 *   • flat  → muted
 *
 * `delta.direction === 'down'` does NOT automatically mean "bad" —
 * for some metrics (e.g. customer-acquisition cost) lower is better,
 * so callers can pass `invertColor` to swap the up/down semantics
 * without us guessing per-metric.
 *
 * Pure presentational — server-component safe.
 */

import * as React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatCardDeltaDirection = 'up' | 'down' | 'flat';

export interface StatCardDelta {
  /** Direction arrow + color. */
  direction: StatCardDeltaDirection;
  /**
   * Pre-formatted delta string (e.g. "+12.3%", "-4%", "0%"). The
   * caller computes this — `lib/trend.ts` returns `null` for divide-
   * by-zero cases, so callers should suppress the delta entirely
   * (don't pass `delta`) instead of rendering "NaN%".
   */
  label: string;
  /** Optional comparison-period label, e.g. "vs last week". */
  caption?: string;
}

export interface StatCardProps {
  /** Small label (e.g. "New leads today"). */
  label: React.ReactNode;
  /**
   * Big number / value. Already-formatted by the caller (currency,
   * thousands separators, percent sign…). Accepts a ReactNode so a
   * caller can render rich content (icon + number) if needed.
   */
  value: React.ReactNode;
  /** Optional delta indicator. Omit for first-period / no-baseline cases. */
  delta?: StatCardDelta;
  /**
   * When `true`, swap the up/down → green/red mapping. Use for
   * "lower is better" metrics like CAC, bug count, churn rate.
   * @default false
   */
  invertColor?: boolean;
  /**
   * Optional sparkline-friendly slot rendered below the value. Caller
   * passes a Recharts `<Sparkline>` or any small chart; we just
   * reserve the space so dashboard rows stay vertically aligned.
   */
  sparkline?: React.ReactNode;
  /** Extra classes on the outer Card. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the Tailwind color classes for a delta indicator. SPEC
 * §13.1 status palette: green/red for up/down, muted for flat.
 */
function deltaColorClass(
  direction: StatCardDeltaDirection,
  invertColor: boolean,
): string {
  if (direction === 'flat') return 'text-muted-foreground';
  const positive = invertColor ? direction === 'down' : direction === 'up';
  return positive ? 'text-status-green' : 'text-status-red';
}

/** Lucide icon for each delta direction. */
function DeltaIcon({ direction }: { direction: StatCardDeltaDirection }) {
  if (direction === 'up') {
    return <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  if (direction === 'down') {
    return <ArrowDownRight className="h-3.5 w-3.5" aria-hidden="true" />;
  }
  return <Minus className="h-3.5 w-3.5" aria-hidden="true" />;
}

/** Screen-reader text for each direction. */
function deltaSrLabel(direction: StatCardDeltaDirection): string {
  if (direction === 'up') return 'up';
  if (direction === 'down') return 'down';
  return 'unchanged';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function StatCard({
  label,
  value,
  delta,
  invertColor = false,
  sparkline,
  className,
}: StatCardProps) {
  return (
    <Card className={cn('flex flex-col gap-2 p-4', className)}>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>

      <div className="flex items-baseline gap-2">
        <div className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
          {value}
        </div>

        {delta ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 text-xs font-medium',
              deltaColorClass(delta.direction, invertColor),
            )}
          >
            <DeltaIcon direction={delta.direction} />
            <span className="sr-only">{deltaSrLabel(delta.direction)}</span>
            <span>{delta.label}</span>
          </span>
        ) : null}
      </div>

      {delta?.caption ? (
        <div className="text-xs text-muted-foreground">{delta.caption}</div>
      ) : null}

      {sparkline ? <div className="mt-1">{sparkline}</div> : null}
    </Card>
  );
}
