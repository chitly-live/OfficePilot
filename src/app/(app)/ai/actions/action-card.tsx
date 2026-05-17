'use client';

/**
 * `<ActionCard />` — client component for a single AIAction row on
 * `/ai/actions`. Renders title + rationale + scope badge + timestamp,
 * with two buttons that POST to `/api/ai/actions/[id]`:
 *
 *   • "Mark done"  → status: 'DONE'
 *   • "Dismiss"    → status: 'DISMISSED'
 *
 * On success, calls `router.refresh()` so the server-rendered list
 * re-fetches and the card moves out of the OPEN section. Errors
 * surface via Sonner toast.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { StatusBadge } from '@/components/shared/StatusBadge';

export interface ActionCardProps {
  action: {
    id: string;
    priority: string;
    scope: string;
    title: string;
    rationale: string;
    status: string;
    generatedAt: string | Date;
  };
}

const PRIORITY_TONE: Record<string, 'red' | 'amber' | 'green' | 'neutral'> = {
  HIGH: 'red',
  MEDIUM: 'amber',
  LOW: 'green',
};

export function ActionCard({ action }: ActionCardProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState<null | 'done' | 'dismiss'>(null);

  const update = async (next: 'DONE' | 'DISMISSED') => {
    setPending(next === 'DONE' ? 'done' : 'dismiss');
    try {
      const res = await fetch(`/api/ai/actions/${action.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      toast.success(next === 'DONE' ? 'Marked as done' : 'Dismissed');
      router.refresh();
    } catch (err) {
      toast.error(`Couldn't update: ${(err as Error).message}`);
    } finally {
      setPending(null);
    }
  };

  const isResolved = action.status === 'DONE' || action.status === 'DISMISSED';

  return (
    <Card className={isResolved ? 'opacity-60' : ''}>
      <CardHeader className="space-y-2 pb-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge
              status={action.priority}
              tone={PRIORITY_TONE[action.priority] ?? 'neutral'}
              label={action.priority}
            />
            <StatusBadge status={action.scope.toUpperCase()} tone="blue" label={action.scope} />
          </div>
          <span className="text-xs text-muted-foreground">
            {new Date(action.generatedAt).toLocaleString('en-IN', {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </span>
        </div>
        <CardTitle className="text-sm font-semibold leading-snug">
          {action.title}
        </CardTitle>
      </CardHeader>

      <CardContent className="pt-0 pb-3">
        <p className="text-sm text-muted-foreground whitespace-pre-line">
          {action.rationale}
        </p>
      </CardContent>

      {!isResolved && (
        <CardFooter className="flex items-center gap-2 pt-0">
          <Button
            size="sm"
            variant="default"
            disabled={pending !== null}
            onClick={() => update('DONE')}
          >
            {pending === 'done' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">Mark done</span>
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={pending !== null}
            onClick={() => update('DISMISSED')}
          >
            {pending === 'dismiss' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <X className="h-3.5 w-3.5" />
            )}
            <span className="ml-1">Dismiss</span>
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
