/**
 * `<LatestInsights>` — Row 2 of the unified dashboard
 * (SPEC.md §11.1 row 2 — "AI Insights (latest 4 cards)").
 *
 * Server Component. Renders exactly four cards in a row, one per
 * canonical scope (`ads | social | leads | overall`), driven by the
 * fixed-length array produced by `loadLatestInsights` in
 * `./loaders.ts`. The slot ordering is decided by the loader; this
 * widget renders whatever sequence it receives so the row is always
 * 4-up.
 *
 * Visibility model (SPEC.md §2.1, §10.1, §11.1):
 *
 *   - The dashboard itself is visible to all employees, so every role
 *     sees the latest summary text.
 *   - Only ADMINs may navigate into a full insight at `/ai/[id]` —
 *     and only ADMINs may generate new insights at `/ai`. The widget
 *     receives `isAdmin` from the page (which already has the session
 *     in hand) and conditionally renders the "View →" / "Generate
 *     one" affordances. Non-admins still see the card body.
 *
 * Per-card behaviour:
 *
 *   - Empty slot (`slot.id === null`): a neutral placeholder card with
 *     the scope label and a "No insights yet" message. Admins also see
 *     a "Generate one" link to `/ai`.
 *   - Filled slot: trend emoji (🟢/🔴/🟡 — same convention as
 *     `/ai/page.tsx`), scope badge, summary clamped to two lines, and
 *     a footer with `formatDistanceToNow(generatedAt)` plus (admin
 *     only) a "View →" link to `/ai/[id]`.
 *
 * `tokenUsage` is intentionally absent here — the slot type produced
 * by the loader doesn't carry it, and the dashboard widget hides AI
 * cost data from non-admins (admins can drill into `/ai` for the full
 * row including token counts).
 *
 * Implements task 76 of `.kiro/specs/officepilot/tasks.md`.
 */

import Link from 'next/link';
import { formatDistanceToNow } from 'date-fns';

import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

import type { InsightScope, LatestInsightSlot } from './loaders';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Human-readable scope titles for the badge / placeholder header.
 *  Matches the labels used in `/ai/page.tsx` so the visual language is
 *  consistent across the dashboard and the admin feed. */
const SCOPE_LABEL: Record<InsightScope, string> = {
  ads: 'Ads',
  social: 'Social',
  leads: 'Leads',
  overall: 'Overall',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Map an `AIInsight.trend` value to the emoji indicator from
 * SPEC.md §10.2 feature 4. Anything other than `up` / `down` (the
 * canonical "flat", a future enum addition, or a legacy row) renders
 * as 🟡 so the card always has an indicator.
 */
function trendEmoji(trend: string | null): string {
  if (trend === 'up') return '🟢';
  if (trend === 'down') return '🔴';
  return '🟡';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LatestInsightsProps {
  /** Always exactly four entries — see `loadLatestInsights`. */
  data: LatestInsightSlot[];
  /** Controls whether per-card "View →" and the empty-state
   *  "Generate one" links render. */
  isAdmin: boolean;
}

export function LatestInsights({ data, isAdmin }: LatestInsightsProps) {
  return (
    <section
      aria-label="Latest AI insights"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {data.map((slot) => (
        <InsightSlotCard key={slot.scope} slot={slot} isAdmin={isAdmin} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// InsightSlotCard
// ---------------------------------------------------------------------------

interface InsightSlotCardProps {
  slot: LatestInsightSlot;
  isAdmin: boolean;
}

function InsightSlotCard({ slot, isAdmin }: InsightSlotCardProps) {
  const scopeLabel = SCOPE_LABEL[slot.scope];

  // -------------------------------------------------------------
  // Empty slot — no insights for this scope yet.
  // -------------------------------------------------------------
  if (slot.id === null) {
    return (
      <Card className="flex h-full flex-col">
        <CardHeader className="space-y-2 pb-3">
          <Badge variant="secondary" className="w-fit">
            {scopeLabel}
          </Badge>
          <CardTitle className="text-sm font-medium text-muted-foreground">
            No insights yet
          </CardTitle>
        </CardHeader>
        <CardFooter className="mt-auto pt-0 text-xs text-muted-foreground">
          {isAdmin ? (
            <Link
              href="/ai"
              className="font-medium text-primary hover:underline"
            >
              Generate one →
            </Link>
          ) : (
            <span>Check back soon</span>
          )}
        </CardFooter>
      </Card>
    );
  }

  // -------------------------------------------------------------
  // Filled slot.
  // -------------------------------------------------------------
  // Loader contract: when `id` is non-null, the rest of the slot is
  // populated. We narrow defensively so TypeScript is happy without
  // runtime non-null assertions further down.
  const generatedAt = slot.generatedAt ?? new Date();
  const summary = slot.summary ?? '';

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="space-y-2 pb-3">
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary" className="w-fit">
            {scopeLabel}
          </Badge>
          <span aria-hidden="true" className="text-xl leading-none">
            {trendEmoji(slot.trend)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="pb-3">
        <p className="line-clamp-2 text-sm text-foreground">{summary}</p>
      </CardContent>

      <CardFooter className="mt-auto flex items-center justify-between gap-2 pt-0 text-xs text-muted-foreground">
        <span>
          {formatDistanceToNow(new Date(generatedAt), { addSuffix: true })}
        </span>
        {isAdmin ? (
          <Link
            href={`/ai/${slot.id}`}
            className="font-medium text-primary hover:underline"
          >
            View →
          </Link>
        ) : null}
      </CardFooter>
    </Card>
  );
}
