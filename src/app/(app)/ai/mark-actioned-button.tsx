'use client';

/**
 * MarkActionedButton — client island that POSTs to
 * `/api/ai/insights/[id]/action` (SPEC.md §10.5; SPEC.md §10.2 #5
 * "Suggestion follow-up").
 *
 * Opens a small dialog with an optional `note` textarea so the
 * admin can record *why* they actioned the suggestion. The note
 * lands in `ActivityLog.metadata` for the audit trail. Posting an
 * empty note is fine — the API treats whitespace-only as absent.
 *
 * On success: toast + close dialog + `router.refresh()` so any
 * derived state (counts, etc.) re-renders. On failure: toast the
 * error and keep the dialog open.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

const NOTE_MAX_LENGTH = 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to action insights.';
  if (status === 404) return 'This insight no longer exists.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface MarkActionedButtonProps {
  /** AI insight id — passed straight into the URL. */
  insightId: string;
  /** Optional scope used in the dialog copy ("Mark this {scope} insight…"). */
  scope?: string;
  /** Button size — `sm` for feed cards, `default` for the detail page. */
  size?: 'sm' | 'default';
}

export function MarkActionedButton({
  insightId,
  scope,
  size = 'default',
}: MarkActionedButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (next) setNote('');
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);

    let res: Response;
    try {
      const trimmed = note.trim();
      const body = trimmed === '' ? {} : { note: trimmed };
      res = await fetch(`/api/ai/insights/${insightId}/action`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      setPending(false);
      toast.error('Network error. Please try again.');
      return;
    }

    let parsed: ApiErrorBody | null = null;
    try {
      parsed = (await res.json()) as ApiErrorBody;
    } catch {
      parsed = null;
    }

    setPending(false);

    if (!res.ok) {
      toast.error(describeError(parsed, res.status));
      return;
    }

    toast.success('Marked as actioned.');
    setOpen(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" size={size} variant="outline">
          <Check className="h-4 w-4" aria-hidden="true" />
          <span>Mark as actioned</span>
        </Button>
      </DialogTrigger>

      <DialogContent>
        <form onSubmit={onSubmit}>
          <DialogHeader>
            <DialogTitle>Mark as actioned</DialogTitle>
            <DialogDescription>
              {scope
                ? `Record what you did about this ${scope} insight. The note is optional.`
                : 'Record what you did about this insight. The note is optional.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2 py-4">
            <Label htmlFor="ai-action-note">Note (optional)</Label>
            <Textarea
              id="ai-action-note"
              name="note"
              rows={4}
              maxLength={NOTE_MAX_LENGTH}
              placeholder="e.g. Boosted Reels budget +20% and paused the underperforming carousel set."
              value={note}
              disabled={pending}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {note.length}/{NOTE_MAX_LENGTH} characters
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  <span>Saving…</span>
                </>
              ) : (
                <>
                  <Check className="h-4 w-4" aria-hidden="true" />
                  <span>Mark as actioned</span>
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
