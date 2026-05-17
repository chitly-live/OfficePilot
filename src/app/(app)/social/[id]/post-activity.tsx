'use client';

/**
 * SocialPostActivity — recent ActivityLog timeline for a single
 * social post (SPEC.md §8.2.4 — winner toggles emit a dedicated
 * activity row; SPEC.md §14 — every important state change is logged).
 *
 * Mirrors the campaign / lead activity timelines — they all delegate
 * to `formatActivity()` from `@/lib/activity`, which already handles
 * every action emitted by the social posts API:
 *   • socialpost.created
 *   • socialpost.updated
 *   • socialpost.published
 *   • socialpost.winner_marked
 *   • socialpost.deleted
 *
 * Owner labels:
 *   • The default formatter falls back to "User {userId}" when
 *     `userName` isn't on `metadata`. We pre-stamp `userName` from
 *     the activity row's user so the timeline reads naturally.
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

export interface SocialPostActivityRow {
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

export interface SocialPostActivityProps {
  items: SocialPostActivityRow[];
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
 * Enrich the metadata blob with `userName` from the activity row's
 * user so `formatActivity()` can render "Jane updated …" rather than
 * "User <cuid> updated …".
 */
function enrichMetadata(row: SocialPostActivityRow): Record<string, unknown> {
  const base: Record<string, unknown> = { ...(row.metadata ?? {}) };
  if (!base.userName) {
    base.userName = row.user.name?.trim() || row.user.email;
  }
  return base;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function SocialPostActivity({ items }: SocialPostActivityProps) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No activity yet"
        description="Edits, status changes, and winner toggles will show up here."
      />
    );
  }

  return (
    <ol className="space-y-2" aria-label="Activity timeline">
      {items.map((row) => {
        const summary = formatActivity({
          userId: row.userId,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          leadId: row.leadId,
          metadata: enrichMetadata(row),
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
