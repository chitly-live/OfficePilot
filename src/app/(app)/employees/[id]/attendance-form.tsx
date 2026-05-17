'use client';

/**
 * AttendanceForm — `react-hook-form` + zod for
 * `POST /api/users/[id]/attendance`.
 *
 * Marks attendance for a single (date, status, notes) tuple. The API
 * uses an upsert keyed on `(userId, date)`, so re-marking the same
 * date overwrites the previous row idempotently — perfect for a
 * "today's attendance" form that may be submitted multiple times.
 *
 * Defaults: `date = today`, `status = 'present'`. Notes are optional
 * and capped at 500 chars (matches `attendanceSchema`).
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { ATTENDANCE_STATUSES } from '@/lib/schemas/users';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const formSchema = z.object({
  date: z
    .string()
    .min(1, 'Date is required')
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date'),
  status: z.enum(ATTENDANCE_STATUSES),
  notes: z
    .string()
    .max(500, 'Notes must be 500 characters or fewer')
    .optional()
    .or(z.literal('')),
});

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to mark attendance here.';
  if (status === 404) return 'User not found.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Invalid attendance entry.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

const STATUS_LABELS: Record<(typeof ATTENDANCE_STATUSES)[number], string> = {
  present: 'Present',
  leave: 'Leave',
  wfh: 'Work from home',
  absent: 'Absent',
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface AttendanceFormProps {
  userId: string;
}

export function AttendanceForm({ userId }: AttendanceFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      date: today(),
      status: 'present',
      notes: '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> = {
      // The API parses both ISO datetimes and date-only strings via
      // `z.coerce.date()`; we send YYYY-MM-DD as that's what the user
      // selected and what the column actually stores.
      date: values.date,
      status: values.status,
    };
    if (values.notes && values.notes.trim() !== '') {
      payload.notes = values.notes.trim();
    }

    let res: Response;
    try {
      res = await fetch(`/api/users/${userId}/attendance`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    if (!res.ok) {
      let body: ApiErrorBody | null = null;
      try {
        body = (await res.json()) as ApiErrorBody;
      } catch {
        body = null;
      }
      toast.error(describeError(body, res.status));
      return;
    }

    toast.success('Attendance recorded.');
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl>
                  <Input type="date" disabled={isSubmitting} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="status"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Status</FormLabel>
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
                    {ATTENDANCE_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="notes"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Notes <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Textarea
                  rows={3}
                  maxLength={500}
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center justify-end pt-1">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Saving…</span>
              </>
            ) : (
              'Mark attendance'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
