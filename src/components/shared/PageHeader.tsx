/**
 * PageHeader — module page header.
 *
 * Used at the top of every authenticated module page (Leads, Marketing,
 * Social, Dev, AI, Settings…) per SPEC §13.1 (dense, internal-tool
 * layout) and the page inventory in SPEC §4.
 *
 * Layout (left → right, single row on ≥sm, stacked on xs):
 *
 *   ┌──────────────────────────────────────────────────────┐
 *   │  Title                                    [actions]  │
 *   │  Subtitle (optional, muted)                          │
 *   └──────────────────────────────────────────────────────┘
 *
 * The `actions` slot is right-aligned so module pages can drop in
 * primary CTAs (e.g. "New lead", "Import CSV") without each page
 * having to re-implement spacing and alignment.
 *
 * Pure presentational — server-component safe (no hooks, no client
 * APIs). Renders a real <header> so the document outline is
 * meaningful for assistive tech.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export interface PageHeaderProps {
  /** Page title — rendered as <h1>. Required. */
  title: React.ReactNode;
  /**
   * Optional muted subtitle, shown below the title. Use sparingly —
   * the dense internal-tool aesthetic (SPEC §13.1) prefers headers
   * that fit on one row.
   */
  subtitle?: React.ReactNode;
  /**
   * Optional right-aligned slot for action buttons, segmented toggles,
   * etc. Wrap multiple buttons in a flex container if you need them
   * stacked or spaced; this slot doesn't impose a layout on its
   * children other than right-alignment relative to the title.
   */
  actions?: React.ReactNode;
  /** Extra classes on the outer <header>. */
  className?: string;
}

/**
 * Renders the page header. See file-level JSDoc for layout details.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <header
      className={cn(
        // Stacked on xs so long titles + actions don't overlap on
        // narrow phones; single row from `sm` upwards.
        'flex flex-col gap-3 border-b pb-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4',
        className,
      )}
    >
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold leading-tight tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>

      {actions ? (
        <div className="flex shrink-0 items-center gap-2 sm:justify-end">
          {actions}
        </div>
      ) : null}
    </header>
  );
}
