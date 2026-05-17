/**
 * StatusBadge — color-coded status pill.
 *
 * Maps a string status to one of the SPEC §13.1 status colors:
 *   • green → "good"     (CONVERTED, ACTIVE, PUBLISHED, DONE)
 *   • red   → "bad"      (LOST, FAILED)
 *   • amber → "warning"  (FOLLOW_UP, PAUSED, DOING, DRAFT)
 *   • blue  → "info"     (NEW, CONTACTED, INTERESTED, SCHEDULED, TODO,
 *                         ENDED)
 *
 * The mapping is intentionally per-status-string (not per-enum-name),
 * so a single component can serve `LeadStatus`, `CampaignStatus`,
 * `PostStatus`, `DevTaskStatus`, etc. Unknown values fall back to a
 * neutral muted badge — better than throwing in production.
 *
 * Generic over the status string type so call sites stay type-safe:
 *
 *   import type { LeadStatus } from '@prisma/client';
 *   <StatusBadge<LeadStatus> status={lead.status} />
 *
 * Pure presentational — server-component safe.
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusTone = 'green' | 'red' | 'amber' | 'blue' | 'neutral';

/**
 * Default mapping of all status strings used across the app's enums.
 * Keys match Prisma enum values exactly (uppercase). When a module
 * needs a custom mapping (e.g. severity levels), pass `tone` directly
 * or extend via `toneMap`.
 */
const DEFAULT_TONE_MAP: Record<string, StatusTone> = {
  // LeadStatus (SPEC §6.2.2 stages)
  NEW: 'blue',
  CONTACTED: 'blue',
  INTERESTED: 'blue',
  FOLLOW_UP: 'amber',
  CONVERTED: 'green',
  LOST: 'red',

  // CampaignStatus (SPEC §3 schema)
  DRAFT: 'amber',
  ACTIVE: 'green',
  PAUSED: 'amber',
  ENDED: 'blue',

  // PostStatus
  SCHEDULED: 'blue',
  PUBLISHED: 'green',
  FAILED: 'red',

  // DevTaskStatus
  TODO: 'blue',
  DOING: 'amber',
  DONE: 'green',

  // Priority (used by leads + dev tasks)
  LOW: 'blue',
  MEDIUM: 'amber',
  HIGH: 'amber',
  URGENT: 'red',
};

/**
 * Tone → Tailwind classes. Uses the `status.*` palette wired in
 * tailwind.config.ts (SPEC §13.1). Backgrounds are tinted at ~10%
 * opacity so the pill stays readable on both light and dark surfaces.
 */
const TONE_CLASSES: Record<StatusTone, string> = {
  green: 'bg-status-green/10 text-status-green ring-status-green/20',
  red: 'bg-status-red/10 text-status-red ring-status-red/20',
  amber: 'bg-status-amber/10 text-status-amber ring-status-amber/20',
  blue: 'bg-status-blue/10 text-status-blue ring-status-blue/20',
  neutral: 'bg-muted text-muted-foreground ring-border',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert an UPPER_SNAKE status to a friendly label
 * ("FOLLOW_UP" → "Follow up"). Callers can override via the `label`
 * prop when they need custom phrasing.
 */
function defaultLabel(status: string): string {
  return status
    .toLowerCase()
    .split('_')
    .map((word, idx) =>
      idx === 0 && word.length > 0
        ? word[0].toUpperCase() + word.slice(1)
        : word,
    )
    .join(' ');
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface StatusBadgeProps<TStatus extends string = string> {
  /** Status string. Typically a Prisma enum value. */
  status: TStatus;
  /**
   * Optional override for the visual tone. When omitted, the tone is
   * resolved via `toneMap`, falling back to the built-in
   * `DEFAULT_TONE_MAP`, then `neutral`.
   */
  tone?: StatusTone;
  /**
   * Optional custom mapping of status string → tone. Merged on top of
   * the built-in defaults (caller-supplied keys win).
   */
  toneMap?: Partial<Record<TStatus, StatusTone>>;
  /**
   * Optional override for the displayed label. Defaults to a sentence-
   * cased version of the status string ("FOLLOW_UP" → "Follow up").
   */
  label?: React.ReactNode;
  /** Extra classes appended to the badge. */
  className?: string;
}

/** See file-level JSDoc. */
export function StatusBadge<TStatus extends string = string>({
  status,
  tone,
  toneMap,
  label,
  className,
}: StatusBadgeProps<TStatus>) {
  const resolvedTone: StatusTone =
    tone ??
    (toneMap?.[status] as StatusTone | undefined) ??
    DEFAULT_TONE_MAP[status] ??
    'neutral';

  const text = label ?? defaultLabel(status);

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        TONE_CLASSES[resolvedTone],
        className,
      )}
    >
      {text}
    </span>
  );
}
