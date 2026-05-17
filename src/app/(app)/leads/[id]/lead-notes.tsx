'use client';

/**
 * LeadNotes — notes feed + add-note form for the lead detail page.
 *
 * SPEC §6.2 #6 ("Notes timeline") + §6.3 (`POST /api/leads/[id]/notes`).
 *
 * The notes list is provided by the server page (initial render) and
 * re-fetched after every successful submit by calling
 * `router.refresh()`, which re-runs the parent Server Component.
 *
 * Authorisation:
 *   • Authenticated users (any role) can read + write notes (leads
 *     are a shared pipeline).
 *   • The author is always the current session user (server-side).
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { format, formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { z } from 'zod';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/shared/EmptyState';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeadNote {
  id: string;
  body: string;
  /** ISO string. */
  createdAt: string;
  author: {
    id: string;
    name: string | null;
    email: string;
    avatarUrl: string | null;
  };
}

export interface LeadNotesProps {
  leadId: string;
  notes: LeadNote[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const formSchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, 'Note body is required')
    .max(5000, 'Note must be 5000 characters or fewer'),
});

type FormValues = z.infer<typeof formSchema>;

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

function formatNoteTimestamp(iso: string): { absolute: string; relative: string } {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return { absolute: '—', relative: '' };
  return {
    absolute: format(date, 'dd MMM yyyy · HH:mm'),
    relative: formatDistanceToNow(date, { addSuffix: true }),
  };
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to add notes here.';
  if (status === 404) return 'Lead not found.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Note rejected.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export function LeadNotes({ leadId, notes }: LeadNotesProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { body: '' },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    let res: Response;
    try {
      res = await fetch(`/api/leads/${leadId}/notes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: values.body }),
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

    toast.success('Note added.');
    form.reset({ body: '' });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* Add note form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
            Add a note
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(onSubmit)}
              className="space-y-3"
              noValidate
            >
              <FormField
                control={form.control}
                name="body"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="sr-only">Note</FormLabel>
                    <FormControl>
                      <Textarea
                        rows={3}
                        maxLength={5000}
                        placeholder="What happened? Add context for the team…"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex justify-end">
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
                    'Add note'
                  )}
                </Button>
              </div>
            </form>
          </Form>
        </CardContent>
      </Card>

      {/* Notes feed */}
      {notes.length === 0 ? (
        <EmptyState
          icon={MessageSquarePlus}
          title="No notes yet"
          description="Add the first note above to start a shared timeline."
        />
      ) : (
        <ol className="space-y-3" aria-label="Notes timeline">
          {notes.map((note) => {
            const { absolute, relative } = formatNoteTimestamp(note.createdAt);
            return (
              <li key={note.id}>
                <Card>
                  <CardContent className="flex gap-3 p-4">
                    <Avatar className="h-9 w-9">
                      {note.author.avatarUrl ? (
                        <AvatarImage
                          src={note.author.avatarUrl}
                          alt={note.author.name ?? note.author.email}
                        />
                      ) : null}
                      <AvatarFallback className="bg-brand-100 text-xs font-semibold text-brand-700 dark:bg-brand-900/60 dark:text-brand-200">
                        {getInitials(note.author.name, note.author.email)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {note.author.name || note.author.email}
                        </span>
                        <time
                          dateTime={note.createdAt}
                          title={absolute}
                          className="text-xs text-muted-foreground"
                        >
                          {relative}
                        </time>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {note.body}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
