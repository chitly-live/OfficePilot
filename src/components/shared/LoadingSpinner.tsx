/**
 * LoadingSpinner — `Loader2` icon with a sized + accessible wrapper.
 *
 * Tiny utility used wherever a quick loading affordance is needed
 * (button busy state, inline indicator, full-page overlay). Three
 * sizes are pre-tuned so we don't sprinkle ad-hoc Tailwind sizes
 * across the codebase:
 *
 *   • sm → 12px (inline, button glyph)
 *   • md → 16px (default, table row / card)
 *   • lg → 24px (full-page or large card overlays)
 *
 * Always announces itself via `role="status"` + an `srLabel` so
 * screen readers don't see "spinning thing" of mystery.
 *
 * Pure presentational — server-component safe (no client hooks).
 */

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LoadingSpinnerSize = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<LoadingSpinnerSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-4 w-4',
  lg: 'h-6 w-6',
};

export interface LoadingSpinnerProps {
  /** Visual size. @default 'md' */
  size?: LoadingSpinnerSize;
  /**
   * Screen-reader-only label. Defaults to "Loading…". Override when
   * the context needs a more specific message ("Saving lead…").
   */
  srLabel?: string;
  /** Extra classes appended to the spinner icon. */
  className?: string;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** See file-level JSDoc. */
export function LoadingSpinner({
  size = 'md',
  srLabel = 'Loading…',
  className,
}: LoadingSpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center"
    >
      <Loader2
        aria-hidden="true"
        className={cn('animate-spin text-muted-foreground', SIZE_CLASSES[size], className)}
      />
      <span className="sr-only">{srLabel}</span>
    </span>
  );
}
