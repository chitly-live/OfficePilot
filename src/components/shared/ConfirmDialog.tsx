'use client';

/**
 * ConfirmDialog — destructive-action confirmation modal.
 *
 * Used for "Delete lead?", "Mark campaign as ended?", "Deactivate
 * employee?" and other state-changing confirmations across the app.
 * Built on the shadcn `Dialog` primitive (no separate AlertDialog
 * primitive is wired in this project — `Dialog` covers the same need
 * with the same Radix engine, so we keep the `ui/` surface lean).
 *
 * Async-friendly:
 *   • `onConfirm` may return a Promise; while pending we disable both
 *     buttons and swap the confirm label for a Loader2 spinner
 *     (SPEC §13.4 loading state).
 *   • Dialog auto-closes on successful confirmation. On error, it
 *     stays open so the caller can render a toast and let the user
 *     try again.
 *
 * Controlled API: caller owns `open` + `onOpenChange`. That's the
 * standard pattern with shadcn Dialog and lets the parent attach the
 * trigger anywhere in its tree (table row menu, kebab, etc.).
 *
 * Client component — owns local pending state and uses `useState`.
 */

import * as React from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfirmDialogProps {
  /** Controlled open state. */
  open: boolean;
  /** Open-state setter; called with `false` when the user cancels or
   *  the dialog auto-closes after a successful confirmation. */
  onOpenChange: (open: boolean) => void;
  /** Dialog title (e.g. "Delete lead?"). */
  title: React.ReactNode;
  /**
   * Optional description below the title. Use it to spell out the
   * consequence: "This permanently removes the lead and its notes."
   */
  description?: React.ReactNode;
  /**
   * Confirmation handler. May return a Promise — we await it and only
   * close the dialog on success. If it throws/rejects, the dialog
   * stays open and the pending state is cleared so the user can
   * retry.
   */
  onConfirm: () => void | Promise<void>;
  /** Confirm-button label. @default "Confirm" */
  confirmLabel?: React.ReactNode;
  /** Cancel-button label. @default "Cancel" */
  cancelLabel?: React.ReactNode;
  /**
   * Visual tone of the confirm button. Defaults to `destructive`
   * because this is overwhelmingly used for delete/danger flows.
   * @default 'destructive'
   */
  confirmVariant?: 'destructive' | 'default';
  /**
   * When true, prevents closing while `onConfirm` is in flight (no
   * Esc, no overlay click, no Cancel button). Defaults to true so the
   * user can't fire two requests by closing-and-reopening mid-flight.
   * @default true
   */
  disableCloseWhilePending?: boolean;
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/** See file-level JSDoc. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  onConfirm,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'destructive',
  disableCloseWhilePending = true,
}: ConfirmDialogProps) {
  const [pending, setPending] = React.useState(false);

  // Track unmount so we don't `setState` on a torn-down tree if the
  // parent unmounts the dialog while `onConfirm` is still resolving.
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /**
   * Wrap the parent's open-change handler so the dialog can't be
   * dismissed while a confirm is in flight (avoids racy double-fires).
   */
  const handleOpenChange = (next: boolean) => {
    if (pending && disableCloseWhilePending && !next) return;
    onOpenChange(next);
  };

  const handleConfirm = async () => {
    if (pending) return;
    try {
      setPending(true);
      await onConfirm();
      // Only close on success. Errors keep the dialog open so the
      // caller can show a toast and let the user retry.
      if (mountedRef.current) {
        onOpenChange(false);
      }
    } finally {
      if (mountedRef.current) {
        setPending(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // While pending, swallow the Radix auto-close events so users
        // can't dismiss with Esc or an outside click.
        onEscapeKeyDown={(event) => {
          if (pending && disableCloseWhilePending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          if (pending && disableCloseWhilePending) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? (
            <DialogDescription>{description}</DialogDescription>
          ) : null}
        </DialogHeader>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending && disableCloseWhilePending}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={confirmVariant}
            onClick={handleConfirm}
            disabled={pending}
            aria-busy={pending}
          >
            {pending ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Working…</span>
              </>
            ) : (
              confirmLabel
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
