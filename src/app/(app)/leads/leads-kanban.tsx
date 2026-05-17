'use client';

/**
 * LeadsKanban — drag-drop pipeline view for `/leads?view=kanban`
 * (SPEC §6.2.2 "Pipeline view (Kanban) with 6 stages
 * NEW → CONTACTED → INTERESTED → FOLLOW_UP → CONVERTED / LOST",
 * §6.5 "Drag lead from NEW → INTERESTED in Kanban → ActivityLog
 * entry created").
 *
 * Wires the generic `KanbanBoard` to the leads list:
 *
 *   • columns        — six `LeadStatus` enum values, in funnel order.
 *   • getItemColumn  — `lead.status`.
 *   • onItemMove     — PATCH `/api/leads/[id]` with `{ status }`.
 *
 * **Optimistic update with revert on failure.** When the user drops
 * a card we:
 *
 *   1. Move the card into the target column locally so the UI
 *      reflects the change immediately (no spinner needed).
 *   2. Fire a `PATCH` to the API.
 *   3. On `ok` → toast success + `router.refresh()` so the rest of
 *      the page (counts, owner stats etc.) re-loads server-side.
 *   4. On non-ok (e.g. 403 — non-owner EMPLOYEE; 404 — race with
 *      another tab; 400 — validation) → toast the server's error
 *      message and revert the card back to its origin column. We
 *      ALSO call `router.refresh()` to force a re-fetch of the
 *      authoritative server state in case the local view drifted
 *      from the DB for any other reason.
 *
 * **Why a Client Component?** Drag-drop is interactive, optimistic
 * state lives in `useState`, and `router.refresh()` is a Client
 * Router API. The parent server page hands us the full pre-fetched
 * `LeadPublic[]` (already filtered, but pagination is bypassed in
 * kanban mode — see the page module's commentary).
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { LeadStatus } from '@prisma/client';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  KanbanBoard,
  type KanbanColumn,
} from '@/components/shared/KanbanBoard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { LeadPublic } from '@/lib/schemas/leads';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Column definitions in the canonical funnel order
 * (SPEC §6.2.2). Accent classes use the same status palette as the
 * StatusBadge so the column headers match the badges on the cards.
 */
const COLUMNS: KanbanColumn[] = [
  {
    id: LeadStatus.NEW,
    title: 'New',
    accentClassName: 'text-status-blue',
  },
  {
    id: LeadStatus.CONTACTED,
    title: 'Contacted',
    accentClassName: 'text-status-blue',
  },
  {
    id: LeadStatus.INTERESTED,
    title: 'Interested',
    accentClassName: 'text-status-amber',
  },
  {
    id: LeadStatus.FOLLOW_UP,
    title: 'Follow up',
    accentClassName: 'text-status-amber',
  },
  {
    id: LeadStatus.CONVERTED,
    title: 'Converted',
    accentClassName: 'text-status-green',
  },
  {
    id: LeadStatus.LOST,
    title: 'Lost',
    accentClassName: 'text-status-red',
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-letter avatar fallback — same convention as the table view. */
function getInitials(
  name: string | null | undefined,
  fallback: string,
): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  const fromFallback = fallback.trim()[0];
  return (fromFallback ?? '?').toUpperCase();
}

/** Compact INR formatter for the card — `₹1.2L`, `₹85k`, `₹500`. */
function formatInrShort(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  if (value >= 10_000_000) return `₹${(value / 10_000_000).toFixed(1)}Cr`;
  if (value >= 100_000) return `₹${(value / 100_000).toFixed(1)}L`;
  if (value >= 1_000) return `₹${(value / 1_000).toFixed(1)}k`;
  return `₹${value.toFixed(0)}`;
}

/**
 * Best-effort JSON error extractor. The API conventionally returns
 * `{ error: 'forbidden' | 'not_found' | … , message?: string }`. We
 * surface the human-readable `message` if present, otherwise a
 * lowercase code label, otherwise a generic fallback.
 */
async function readErrorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string' && body.message.trim()) {
        return body.message;
      }
      if (typeof body.error === 'string' && body.error.trim()) {
        return body.error;
      }
    }
  } catch {
    // Non-JSON body — fall through.
  }
  if (res.status === 403) return 'You do not have permission to move this lead';
  if (res.status === 404) return 'Lead no longer exists';
  return `Update failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Compact card rendered for each lead in a column. Shows:
 *
 *   • Lead name (link to `/leads/[id]` — opens detail in a new
 *     view; click stops propagation so it doesn't trigger a drag).
 *   • Company (or — if missing).
 *   • Owner avatar + name (or "Unassigned").
 *   • Estimated value (compact INR, suppressed when null).
 *   • Priority badge (only when not MEDIUM, to keep cards tidy).
 *
 * Layout is intentionally dense — kanban cards are scanned more than
 * read. Heavier detail (notes, follow-up date) lives on `/leads/[id]`.
 */
function LeadCard({ lead }: { lead: LeadPublic }) {
  const owner = lead.owner;
  const valueLabel = formatInrShort(lead.value);
  // MEDIUM is the default priority and dominates the dataset; only
  // surface a badge when something actionable diverges from default.
  const showPriority = lead.priority !== 'MEDIUM';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            href={`/leads/${lead.id}`}
            // Stop the click from being interpreted as the start of a
            // drag-pointer gesture. `@dnd-kit` uses an activation
            // distance (6 px) which gives ordinary clicks through, but
            // belt-and-suspenders here is cheap.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-sm font-medium text-foreground hover:underline"
          >
            {lead.name}
          </Link>
          {lead.company ? (
            <div className="truncate text-xs text-muted-foreground">
              {lead.company}
            </div>
          ) : null}
        </div>

        {showPriority ? (
          <StatusBadge status={lead.priority} className="shrink-0" />
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {owner ? (
            <>
              <Avatar className="h-6 w-6">
                {owner.avatarUrl ? (
                  <AvatarImage src={owner.avatarUrl} alt={owner.name} />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-[9px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(owner.name, owner.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-xs text-muted-foreground">
                {owner.name || owner.email}
              </span>
            </>
          ) : (
            <span className="text-xs italic text-muted-foreground">
              Unassigned
            </span>
          )}
        </div>

        {valueLabel ? (
          <span
            className={cn(
              'shrink-0 text-xs font-medium tabular-nums text-foreground',
            )}
          >
            {valueLabel}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface LeadsKanbanProps {
  /**
   * Pre-fetched leads (already filter-applied by the server page).
   * Pagination is bypassed in kanban mode — the page caps at the
   * Lead API's max page size (200 rows) so large pipelines still
   * render in finite time.
   */
  items: LeadPublic[];
}

/** See file-level JSDoc. */
export function LeadsKanban({ items }: LeadsKanbanProps) {
  const router = useRouter();

  // Hold an optimistic copy of the leads list so a drop can update
  // the column immediately while the PATCH is in flight. We seed
  // from props and re-sync whenever the server hands us a fresh
  // list (page revalidate, filter change, router.refresh, etc.).
  const [optimisticItems, setOptimisticItems] = React.useState(items);
  React.useEffect(() => {
    setOptimisticItems(items);
  }, [items]);

  const handleMove = React.useCallback(
    async (lead: LeadPublic, fromColumnId: string, toColumnId: string) => {
      // The KanbanBoard guarantees fromColumnId !== toColumnId, but
      // be defensive — a duplicate event would otherwise spam the API.
      if (fromColumnId === toColumnId) return;

      const targetStatus = toColumnId as LeadStatus;

      // 1. Optimistic update — flip the card's status locally so the
      //    UI moves it into the new column right away.
      setOptimisticItems((prev) =>
        prev.map((item) =>
          item.id === lead.id ? { ...item, status: targetStatus } : item,
        ),
      );

      // 2. Persist via the API. The PATCH route handles status-change
      //    activity logging (LEAD_STATUS_CHANGED, plus LEAD_CONVERTED
      //    on first transition into CONVERTED).
      try {
        const res = await fetch(`/api/leads/${lead.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: targetStatus }),
        });

        if (!res.ok) {
          const message = await readErrorMessage(res);
          // 3a. Revert — put the card back where it was, then refresh
          //     so anything else that drifted re-syncs from the DB.
          setOptimisticItems((prev) =>
            prev.map((item) =>
              item.id === lead.id
                ? { ...item, status: fromColumnId as LeadStatus }
                : item,
            ),
          );
          toast.error(`Couldn't move ${lead.name}`, { description: message });
          router.refresh();
          return;
        }

        // 3b. Success — toast and refresh so server-driven derived
        //     data (counts, owner stats, activity log) reloads.
        toast.success(`Moved ${lead.name} → ${labelFor(targetStatus)}`);
        router.refresh();
      } catch (err) {
        // Network error or thrown exception. Treat it the same as a
        // failed response so the user always sees a revert.
        setOptimisticItems((prev) =>
          prev.map((item) =>
            item.id === lead.id
              ? { ...item, status: fromColumnId as LeadStatus }
              : item,
          ),
        );
        const message =
          err instanceof Error ? err.message : 'Network error — try again';
        toast.error(`Couldn't move ${lead.name}`, { description: message });
        router.refresh();
      }
    },
    [router],
  );

  return (
    <KanbanBoard<LeadPublic>
      columns={COLUMNS}
      items={optimisticItems}
      getItemColumn={(lead) => lead.status}
      getItemId={(lead) => lead.id}
      onItemMove={handleMove}
      renderCard={(lead) => <LeadCard lead={lead} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve a column id back to its display label for toasts. */
function labelFor(status: LeadStatus): string {
  const col = COLUMNS.find((c) => c.id === status);
  return typeof col?.title === 'string' ? col.title : status;
}
