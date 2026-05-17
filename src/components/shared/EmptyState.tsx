/**
 * EmptyState — designed empty state for list/table surfaces.
 *
 * Per SPEC §13.3 every list MUST have a designed empty state with:
 *   • icon
 *   • message
 *   • primary action button
 *
 * "No blank screens" — that's why this component is required for any
 * page that paginates rows (Leads, Campaigns, Social posts, Dev
 * tasks, AI insights, Employees, …).
 *
 * Pure presentational — server-component safe. The CTA renders any
 * ReactNode the caller passes (typically a `<Button>` or `<Link>`),
 * so we don't have to thread variants/size props through.
 */

import * as React from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

export interface EmptyStateProps {
  /**
   * Icon component. Defaults to a generic inbox glyph so callers can
   * render without picking one. Accepts any `lucide-react` icon (or
   * any component sharing the `LucideIcon` signature).
   */
  icon?: LucideIcon;
  /** Main message — rendered as a heading. */
  title: React.ReactNode;
  /**
   * Optional supporting copy below the title. Use it to explain how
   * to populate this list (e.g. "Import a CSV or add your first lead
   * to get started.").
   */
  description?: React.ReactNode;
  /**
   * Optional CTA — usually a `<Button>` or a Next.js `<Link>`
   * styled like one. Skipped silently when omitted.
   */
  action?: React.ReactNode;
  /** Extra classes on the outer container. */
  className?: string;
}

/**
 * Renders the empty state. See file-level JSDoc for SPEC linkage.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        // Centered column with a touch of vertical breathing room.
        // Caller wraps this in a Card / TableBody as needed.
        'flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed bg-muted/20 px-6 py-12 text-center',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Icon className="h-6 w-6" />
      </span>

      <div className="space-y-1">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="max-w-sm text-sm text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>

      {action ? <div className="pt-1">{action}</div> : null}
    </div>
  );
}
