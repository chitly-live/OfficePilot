'use client';

/**
 * GenerateInsightButton — client island that opens a dialog for
 * `POST /api/ai/generate` (SPEC.md §10.5).
 *
 * Form fields (matching `aiGenerateSchema`):
 *
 *   • `scope`        — one of "ads" | "social" | "leads" | "overall".
 *   • `periodStart`  — date input, defaults to "today − 7 days".
 *   • `periodEnd`    — date input, defaults to "today".
 *
 * Both date inputs are bound as `YYYY-MM-DD`; we convert to UTC ISO
 * strings on submit so the API's Zod `coerce.date()` parses them
 * cleanly. The form refuses `periodStart >= periodEnd` client-side
 * to mirror the API's `.refine(...)` and surface the error inline
 * before the network roundtrip.
 *
 * On success: toast + close dialog + `router.refresh()` so the feed
 * picks up the new row. On failure: toast the API error message and
 * keep the dialog open so the admin can retry without re-typing.
 *
 * Two presentation variants:
 *
 *   • `"primary"` (default) — used in the page header. Solid button.
 *   • `"empty-state"`       — used inside the EmptyState card.
 *                             Matches the small-button look there.
 *
 * Implements task 70 of `.kiro/specs/officepilot/tasks.md`.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { aiScopeEnum } from '@/lib/schemas/ai';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const formSchema = z
  .object({
    scope: aiScopeEnum,
    periodStart: z.string().min(1, 'Start date is required'),
    periodEnd: z.string().min(1, 'End date is required'),
  })
  .refine(
    (val) => {
      const start = Date.parse(`${val.periodStart}T00:00:00Z`);
      const end = Date.parse(`${val.periodEnd}T23:59:59Z`);
      return Number.isFinite(start) && Number.isFinite(end) && start < end;
    },
    {
      message: 'Start date must be before end date',
      path: ['periodStart'],
    },
  );

type FormValues = z.infer<typeof formSchema>;

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
  if (status === 403) return 'You are not allowed to generate insights.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

/** Format a Date as `YYYY-MM-DD` in the LOCAL timezone — what the
 *  native date input expects. */
function toDateInput(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const SCOPE_LABEL: Record<z.infer<typeof aiScopeEnum>, string> = {
  ads: 'Ads',
  social: 'Social',
  leads: 'Leads',
  overall: 'Overall',
  predictions: 'Predictions',
  anomalies: 'Anomalies',
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface GenerateInsightButtonProps {
  /**
   * Visual variant. `"primary"` (default) renders a solid button for
   * the page header. `"empty-state"` renders an outline-styled button
   * sized to slot inside the EmptyState card.
   */
  variant?: 'primary' | 'empty-state';
}

export function GenerateInsightButton({
  variant = 'primary',
}: GenerateInsightButtonProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  // Compute defaults once per mount; re-opening the dialog reuses the
  // same `today − 7d → today` window so the form is predictable.
  const defaultDates = React.useMemo(() => {
    const today = new Date();
    const sevenAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    return {
      periodStart: toDateInput(sevenAgo),
      periodEnd: toDateInput(today),
    };
  }, []);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      scope: 'overall',
      ...defaultDates,
    },
  });

  // Reset to defaults whenever the dialog opens — avoids "stale form
  // shows last attempt's error inline" after closing and re-opening.
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      if (next) {
        form.reset({ scope: 'overall', ...defaultDates });
      }
    },
    [form, defaultDates],
  );

  const isSubmitting = form.formState.isSubmitting;

  const onSubmit = async (values: FormValues) => {
    // Convert YYYY-MM-DD → full-day UTC ISO strings. The API's Zod
    // schema accepts either a Date or an ISO string via `coerce.date`.
    const periodStart = new Date(`${values.periodStart}T00:00:00Z`).toISOString();
    const periodEnd = new Date(`${values.periodEnd}T23:59:59Z`).toISOString();

    let res: Response;
    try {
      res = await fetch('/api/ai/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: values.scope,
          periodStart,
          periodEnd,
        }),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }

    if (!res.ok) {
      toast.error(describeError(body, res.status));
      return;
    }

    toast.success('Insight generated.');
    setOpen(false);
    router.refresh();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant={variant === 'empty-state' ? 'outline' : 'default'}
        >
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          <span>Generate now</span>
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Generate insight</DialogTitle>
          <DialogDescription>
            Pick a scope and a window. Claude will analyse the metrics
            for that period against the same-duration prior window.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="ai-generate-form"
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-4"
            noValidate
          >
            <FormField
              control={form.control}
              name="scope"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Scope</FormLabel>
                  <Select
                    value={field.value}
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(Object.keys(SCOPE_LABEL) as Array<
                        keyof typeof SCOPE_LABEL
                      >).map((s) => (
                        <SelectItem key={s} value={s}>
                          {SCOPE_LABEL[s]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="periodStart"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Start date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="periodEnd"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>End date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </form>
        </Form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" form="ai-generate-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Generating…</span>
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                <span>Generate</span>
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
