'use client';

/**
 * DevKanban — drag-drop Kanban view for `/dev` (SPEC.md §9.2.1).
 *
 * Wires the generic `KanbanBoard` to the dev-task list:
 *
 *   • columns        — three `DevTaskStatus` enum values (TODO ·
 *                      DOING · DONE), in workflow order.
 *   • getItemColumn  — `task.status`.
 *   • onItemMove     — PATCH `/api/dev/tasks/[id]` with `{ status }`.
 *
 * **Optimistic update with revert on failure.** When the user drops
 * a card we:
 *
 *   1. Move the card into the target column locally so the UI
 *      reflects the change immediately (no spinner needed).
 *   2. Fire a `PATCH` to the API.
 *   3. On `ok` → toast success + `router.refresh()` so the rest of
 *      the page (counts, completion stats) re-loads server-side.
 *   4. On non-ok (e.g. 403 — non-assignee EMPLOYEE; 404 — race
 *      with another tab; 400 — validation) → toast the server's
 *      error message and revert the card back to its origin column.
 *
 * Mirrors the leads kanban (`leads-kanban.tsx`) so the two surfaces
 * behave identically — same revert-on-error semantics, same
 * `router.refresh()` after a successful drop.
 *
 * **Why a Client Component?** Drag-drop is interactive, optimistic
 * state lives in `useState`, and `router.refresh()` is a Client
 * Router API. The parent server page hands us the full pre-fetched
 * `DevTaskPublic[]` (already filtered).
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DevTaskStatus, DevTaskType, type Priority } from '@prisma/client';
import { format } from 'date-fns';
import { toast } from 'sonner';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  KanbanBoard,
  type KanbanColumn,
} from '@/components/shared/KanbanBoard';
import { StatusBadge } from '@/components/shared/StatusBadge';
import type { DevTaskPublic } from '@/lib/schemas/dev';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Column definitions in workflow order (SPEC.md §9.2.1). Accent
 * classes use the same status palette as the StatusBadge so column
 * headers match the badges on the cards.
 */
const COLUMNS: KanbanColumn[] = [
  { id: DevTaskStatus.TODO, title: 'To do', accentClassName: 'text-status-blue' },
  { id: DevTaskStatus.DOING, title: 'Doing', accentClassName: 'text-status-amber' },
  { id: DevTaskStatus.DONE, title: 'Done', accentClassName: 'text-status-green' },
];

/**
 * Friendly label for each task type. Used as the type badge on the
 * card so a quick scan reveals "this is a bug" vs "feature" vs
 * "release log entry".
 */
const TYPE_LABELS: Record<DevTaskType, string> = {
  FEATURE: 'Feature',
  BUG: 'Bug',
  CHORE: 'Chore',
  RELEASE: 'Release',
};

/**
 * Tone mapping for the type badge. Bugs are red (regression-coded),
 * features green (new value), chores neutral (housekeeping),
 * releases blue (informational milestone).
 */
const TYPE_TONE: Record<DevTaskType, 'green' | 'red' | 'amber' | 'blue' | 'neutral'> = {
  FEATURE: 'green',
  BUG: 'red',
  CHORE: 'neutral',
  RELEASE: 'blue',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-letter avatar fallback — same convention as the rest of the app. */
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

/**
 * Best-effort JSON error extractor. The API conventionally returns
 * `{ error: 'forbidden' | 'not_found' | … , message?: string }`.
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
  if (res.status === 403) return 'You do not have permission to move this task';
  if (res.status === 404) return 'Task no longer exists';
  return `Update failed (${res.status})`;
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

/**
 * Compact card for each task in a column. Shows:
 *
 *   • Type badge (colour-coded by Bug / Feature / Chore / Release).
 *   • Title (link to `/dev/[id]` — drag activation distance prevents
 *     plain clicks from triggering a drag).
 *   • Priority badge (only when not MEDIUM — keeps cards tidy).
 *   • Assignee avatar + name (or "Unassigned").
 *   • Target week (only when set).
 */
function DevTaskCard({ task }: { task: DevTaskPublic }) {
  const assignee = task.assignee;
  const showPriority = task.priority !== 'MEDIUM';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-2">
            <StatusBadge<DevTaskType>
              status={task.type}
              tone={TYPE_TONE[task.type]}
              label={TYPE_LABELS[task.type]}
              className="shrink-0"
            />
            {showPriority ? (
              <StatusBadge<Priority>
                status={task.priority}
                className="shrink-0"
              />
            ) : null}
          </div>
          <Link
            href={`/dev/${task.id}`}
            // Stop the click from being interpreted as the start of a
            // drag-pointer gesture. `@dnd-kit` uses an activation
            // distance (6 px) which gives ordinary clicks through, but
            // belt-and-suspenders here is cheap.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            className="block truncate text-sm font-medium text-foreground hover:underline"
          >
            {task.title}
          </Link>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {assignee ? (
            <>
              <Avatar className="h-6 w-6">
                {assignee.avatarUrl ? (
                  <AvatarImage src={assignee.avatarUrl} alt={assignee.name} />
                ) : null}
                <AvatarFallback className="bg-brand-100 text-[9px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                  {getInitials(assignee.name, assignee.email)}
                </AvatarFallback>
              </Avatar>
              <span className="truncate text-xs text-muted-foreground">
                {assignee.name || assignee.email}
              </span>
            </>
          ) : (
            <span className="text-xs italic text-muted-foreground">
              Unassigned
            </span>
          )}
        </div>

        {task.targetWeek ? (
          <span
            className={cn(
              'shrink-0 text-xs tabular-nums text-muted-foreground',
            )}
            title={`Target week starting ${format(new Date(task.targetWeek), 'dd MMM yyyy')}`}
          >
            {format(new Date(task.targetWeek), 'dd MMM')}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface DevKanbanProps {
  /**
   * Pre-fetched tasks (already filter-applied by the server page).
   * The page caps the fetched set at the API's max page size (200
   * rows) so large backlogs still render in finite time.
   */
  items: DevTaskPublic[];
}

/** See file-level JSDoc. */
export function DevKanban({ items }: DevKanbanProps) {
  const router = useRouter();

  // Hold an optimistic copy of the task list so a drop can update
  // the column immediately while the PATCH is in flight. We seed
  // from props and re-sync whenever the server hands us a fresh
  // list (page revalidate, filter change, router.refresh, etc.).
  const [optimisticItems, setOptimisticItems] = React.useState(items);
  React.useEffect(() => {
    setOptimisticItems(items);
  }, [items]);

  const handleMove = React.useCallback(
    async (task: DevTaskPublic, fromColumnId: string, toColumnId: string) => {
      // The KanbanBoard guarantees fromColumnId !== toColumnId, but
      // be defensive — a duplicate event would otherwise spam the API.
      if (fromColumnId === toColumnId) return;

      const targetStatus = toColumnId as DevTaskStatus;

      // 1. Optimistic update — flip the card's status locally so the
      //    UI moves it into the new column right away.
      setOptimisticItems((prev) =>
        prev.map((item) =>
          item.id === task.id ? { ...item, status: targetStatus } : item,
        ),
      );

      // 2. Persist via the API. The PATCH route handles status-change
      //    activity logging (DEVTASK_MOVED, plus DEVTASK_COMPLETED
      //    on first transition into DONE) and the `completedAt`
      //    auto-stamp.
      try {
        const res = await fetch(`/api/dev/tasks/${task.id}`, {
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
              item.id === task.id
                ? { ...item, status: fromColumnId as DevTaskStatus }
                : item,
            ),
          );
          toast.error(`Couldn't move "${task.title}"`, {
            description: message,
          });
          router.refresh();
          return;
        }

        // 3b. Success — toast and refresh so server-driven derived
        //     data (counts, completion stats, activity log) reloads.
        toast.success(`Moved "${task.title}" → ${labelFor(targetStatus)}`);
        router.refresh();
      } catch (err) {
        // Network error or thrown exception. Treat it the same as a
        // failed response so the user always sees a revert.
        setOptimisticItems((prev) =>
          prev.map((item) =>
            item.id === task.id
              ? { ...item, status: fromColumnId as DevTaskStatus }
              : item,
          ),
        );
        const message =
          err instanceof Error ? err.message : 'Network error — try again';
        toast.error(`Couldn't move "${task.title}"`, { description: message });
        router.refresh();
      }
    },
    [router],
  );

  return (
    <KanbanBoard<DevTaskPublic>
      columns={COLUMNS}
      items={optimisticItems}
      getItemColumn={(task) => task.status}
      getItemId={(task) => task.id}
      onItemMove={handleMove}
      renderCard={(task) => <DevTaskCard task={task} />}
    />
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Resolve a column id back to its display label for toasts. */
function labelFor(status: DevTaskStatus): string {
  const col = COLUMNS.find((c) => c.id === status);
  return typeof col?.title === 'string' ? col.title : status;
}
