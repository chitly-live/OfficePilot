'use client';

/**
 * LeadActivity — recent ActivityLog timeline for a single lead.
 *
 * SPEC §6.1 ("activity") + §6.5 ("Drag lead from NEW → INTERESTED in
 * Kanban → ActivityLog entry created").
 *
 * Data is provided by the parent server page — fetched once with
 * `prisma.activityLog.findMany({ where: { leadId } })`. Each row is
 * formatted via `formatActivity` from `@/lib/activity`, which already
 * handles every action emitted by the leads API (created / updated /
 * status_changed / assigned / converted / deleted / note_added /
 * webhook_received / imported).
 *
 * Owner labels:
 *   • The default `formatActivity` template falls back to "User
 *     {userId}" when `userName` isn't on `metadata` and to "{from
 *     ownerId}" / "{to ownerId}" for `LEAD_ASSIGNED`.
 *   • We pre-stamp `userName` and `toOwnerName` from the parent's
 *     owner-label lookup so the timeline reads naturally without
 *     touching the server-side activity helpers.
 */

import * as React from 'react';
import { format, formatDistanceToNow } from 'date-fns';
import { Activity } from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Card, CardContent } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/EmptyState';
import { formatActivity } from '@/lib/activity';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadActivityRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  leadId: string | null;
  metadata: Record<string, unknown> | null;
  /** ISO string. */
  createdAt: string;
  userId: string;
  user: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  };
}

export interface LeadActivityProps {
  items: LeadActivityRow[];
  /**
   * Optional lookup of `User.id → display label` so the formatter can
   * render "assigned to Jane" rather than "assigned to {cuid}". The
   * parent page builds this once from the active-user list.
   */
  ownerLabelById?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInitials(name: string | null, email: string): string {
  const source = (name ?? '').trim();
  if (source) {
    const parts = source.split(/\s+/).slice(0, 2);
    const initials = parts.map((p) => p[0] ?? '').join('');
    if (initials) return initials.toUpperCase();
  }
  return (email.trim()[0] ?? '?').toUpperCase();
}

function formatTimestamp(iso: string): { absolute: string; relative: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { absolute: '—', relative: '' };
  return {
    absolute: format(date, 'dd MMM yyyy · HH:mm'),
    relative: formatDistanceToNow(date, { addSuffix: true }),
  };
}

/**
 * Enrich the metadata blob with display-friendly fields the format
 * helper looks for: `userName` from the activity row's user, and
 * `toOwnerName` for `LEAD_ASSIGNED` entries when we can resolve the
 * owner id to a label.
 */
function enrichMetadata(
  row: LeadActivityRow,
  ownerLabelById?: Record<string, string>,
): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (!base.userName) {
    base.userName = row.user.name?.trim() || row.user.email;
  }
  if (
    row.action === 'lead.assigned' &&
    typeof base.toOwnerId === 'string' &&
    !base.toOwnerName &&
    ownerLabelById
  ) {
    const label = ownerLabelById[base.toOwnerId as string];
    if (label) base.toOwnerName = label;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function LeadActivity({ items, ownerLabelById }: LeadActivityProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Status changes, edits, and notes will show up here."
      />
    );
  }

  return (
    <ol className="space-y-2" aria-label="Activity timeline">
      {items.map((row) => {
        const enrichedMeta = enrichMetadata(row, ownerLabelById);
        const summary = formatActivity({
          userId: row.userId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          leadId: row.leadId,
          metadata: enrichedMeta,
        });
        const { absolute, relative } = formatTimestamp(row.createdAt);

        return (
          <li key={row.id}>
            <Card>
              <CardContent className="flex items-start gap-3 p-3">
                <Avatar className="h-7 w-7">
                  {row.user.avatarUrl ? (
                    <AvatarImage
                      src={row.user.avatarUrl}
                      alt={row.user.name ?? row.user.email}
                    />
                  ) : null}
                  <AvatarFallback className="bg-brand-100 text-[10px] font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                    {getInitials(row.user.name, row.user.email)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-foreground">{summary}</p>
                  <time
                    dateTime={row.createdAt}
                    title={absolute}
                    className="text-xs text-muted-foreground"
                  >
                    {relative}
                  </time>
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ol>
  );
}
