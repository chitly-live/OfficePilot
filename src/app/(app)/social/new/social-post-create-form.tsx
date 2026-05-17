'use client';

/**
 * SocialPostCreateForm — `react-hook-form` + zod form for
 * `POST /api/social/posts` (SPEC.md §8.1, §8.2.2).
 *
 * Mirrors the API's `socialPostCreateSchema` so client and server
 * validate the same shape. On submit:
 *
 *   1. POSTs JSON to `/api/social/posts`.
 *   2. On success → redirect to `/social/[id]` (the new row).
 *   3. On 4xx/5xx → toast the error and stay on the form.
 *
 * Field-level notes:
 *   • `platform` is required.
 *   • `status` is one of DRAFT / SCHEDULED. PUBLISHED + FAILED are
 *     reachable only from the detail page (a "create as published"
 *     workflow doesn't exist in v1 — SPEC.md §8.2.2 is explicit).
 *   • `caption` is required, max 5 000 chars.
 *   • `mediaUrls` and `hashtags` are chip inputs (see the component
 *     siblings).
 *   • `scheduledAt` is split into a date input + a time input;
 *     required when status === SCHEDULED.
 *   • `externalId` and `externalUrl` are surfaced here for completeness
 *     even though they're more commonly filled in after publishing —
 *     a power-user creating a "log only" entry for a post that's
 *     already live can fill them in immediately.
 *   • `ownerId` defaults to the current user; admins can pick any
 *     active user.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import {
  PostStatus,
  SocialPlatform,
  type Role,
} from '@prisma/client';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormDescription,
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

import type { HashtagSet } from '../hashtag-sets';
import { HashtagsInput } from '../hashtags-input';
import { MediaUrlsInput } from '../media-urls-input';

// ---------------------------------------------------------------------------
// Schema (client-side mirror of `socialPostCreateSchema`)
// ---------------------------------------------------------------------------

/**
 * `status` on the create form is constrained to DRAFT or SCHEDULED.
 * Going straight to PUBLISHED on create is intentionally not
 * supported — SPEC.md §8.2.2 frames publishing as a manual status
 * update from the detail page, with `externalUrl` filled in after.
 */
const CREATE_STATUSES = [PostStatus.DRAFT, PostStatus.SCHEDULED] as const;
type CreateStatus = (typeof CREATE_STATUSES)[number];

const formSchema = z
  .object({
    platform: z.nativeEnum(SocialPlatform),
    status: z.enum(CREATE_STATUSES),
    caption: z
      .string()
      .trim()
      .min(1, 'Caption is required')
      .max(5000, 'Caption must be 5000 characters or fewer'),
    mediaUrls: z.array(z.string()).max(10),
    hashtags: z.array(z.string()).max(30),
    scheduledDate: z
      .string()
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => !val || !Number.isNaN(new Date(val).getTime()),
        'Invalid date',
      ),
    scheduledTime: z
      .string()
      .optional()
      .or(z.literal('')),
    externalId: z
      .string()
      .trim()
      .max(200, 'External ID must be 200 characters or fewer')
      .optional()
      .or(z.literal('')),
    externalUrl: z
      .string()
      .trim()
      .max(2048, 'URL must be 2048 characters or fewer')
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => {
          if (!val) return true;
          try {
            const u = new URL(val);
            return u.protocol === 'http:' || u.protocol === 'https:';
          } catch {
            return false;
          }
        },
        'Enter a valid http(s) URL',
      ),
    ownerId: z.string().min(1, 'Owner is required'),
  })
  .refine(
    (val) => val.status !== PostStatus.SCHEDULED || Boolean(val.scheduledDate),
    {
      message: 'Schedule date is required when status is Scheduled',
      path: ['scheduledDate'],
    },
  );

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedPost {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to create posts here.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

const PLATFORM_LABELS: Record<SocialPlatform, string> = {
  INSTAGRAM: 'Instagram',
  FACEBOOK: 'Facebook',
  TWITTER: 'Twitter',
  LINKEDIN: 'LinkedIn',
  YOUTUBE: 'YouTube',
  THREADS: 'Threads',
};

const STATUS_LABELS: Record<CreateStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
};

const PLATFORM_VALUES = Object.keys(PLATFORM_LABELS) as SocialPlatform[];

/**
 * Combine a YYYY-MM-DD date and HH:MM time into a UTC ISO string.
 * Time defaults to "09:00" (a sensible business-hours slot) so an
 * editor who only picks a date doesn't get a midnight schedule.
 */
function combineDateTime(date: string, time: string): string {
  const t = time.trim() === '' ? '09:00' : time;
  // Browsers parse `YYYY-MM-DDTHH:MM` as local time; converting via
  // toISOString() gives us a stable UTC representation the API can
  // round-trip cleanly through `z.coerce.date()`.
  const local = new Date(`${date}T${t}:00`);
  return local.toISOString();
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface OwnerOption {
  id: string;
  label: string;
}

export interface SocialPostCreateFormProps {
  currentUserId: string;
  currentUserRole: Role;
  ownerOptions: OwnerOption[];
  /**
   * Saved hashtag sets from `Setting('hashtag_sets')` — rendered as
   * quick-paste buttons above the hashtag chip input. Optional; when
   * empty/undefined the buttons are hidden (SPEC.md §8.2 #5).
   */
  hashtagSets?: HashtagSet[];
}

export function SocialPostCreateForm({
  currentUserId,
  ownerOptions,
  hashtagSets,
}: SocialPostCreateFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      platform: SocialPlatform.INSTAGRAM,
      status: PostStatus.DRAFT,
      caption: '',
      mediaUrls: [],
      hashtags: [],
      scheduledDate: '',
      scheduledTime: '',
      externalId: '',
      externalUrl: '',
      ownerId: currentUserId,
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const status = form.watch('status');
  const isScheduled = status === PostStatus.SCHEDULED;

  async function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> = {
      platform: values.platform,
      status: values.status,
      caption: values.caption.trim(),
      mediaUrls: values.mediaUrls,
      hashtags: values.hashtags,
      ownerId: values.ownerId,
    };

    const scheduleDate = (values.scheduledDate ?? '').trim();
    if (scheduleDate !== '') {
      payload.scheduledAt = combineDateTime(
        scheduleDate,
        (values.scheduledTime ?? '').trim(),
      );
    }

    const externalIdTrim = (values.externalId ?? '').trim();
    if (externalIdTrim !== '') payload.externalId = externalIdTrim;

    const externalUrlTrim = (values.externalUrl ?? '').trim();
    if (externalUrlTrim !== '') payload.externalUrl = externalUrlTrim;

    let res: Response;
    try {
      res = await fetch('/api/social/posts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | CreatedPost | null = null;
    try {
      body = (await res.json()) as ApiErrorBody | CreatedPost;
    } catch {
      body = null;
    }

    if (!res.ok) {
      toast.error(describeError(body as ApiErrorBody | null, res.status));
      return;
    }

    const created = body as CreatedPost | null;
    if (!created?.id) {
      toast.error('Unexpected response from the server.');
      return;
    }

    toast.success('Post created.');
    router.replace(`/social/${created.id}`);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-5"
        noValidate
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="platform"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Platform</FormLabel>
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
                    {PLATFORM_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {PLATFORM_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
                    {CREATE_STATUSES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {STATUS_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Switch to <strong>Published</strong> from the detail
                  page once the post goes live.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="caption"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Caption</FormLabel>
              <FormControl>
                <Textarea
                  rows={6}
                  maxLength={5000}
                  placeholder="What does this post say?"
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
          name="mediaUrls"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Media URLs{' '}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <MediaUrlsInput
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isSubmitting}
                />
              </FormControl>
              <FormDescription>
                Up to 10 URLs (images, videos, or post thumbnails).
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="hashtags"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Hashtags{' '}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <HashtagsInput
                  value={field.value}
                  onChange={field.onChange}
                  disabled={isSubmitting}
                  sets={hashtagSets}
                />
              </FormControl>
              <FormDescription>
                Press Enter, space, or comma to commit a hashtag. The
                leading <code>#</code> is added automatically.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="scheduledDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Schedule date{' '}
                  {isScheduled ? (
                    <span className="text-destructive">*</span>
                  ) : (
                    <span className="text-muted-foreground">(optional)</span>
                  )}
                </FormLabel>
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
            name="scheduledTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Schedule time{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="time"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Defaults to 9:00 if left blank.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="space-y-3 rounded-md border bg-muted/20 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              External link{' '}
              <span className="text-muted-foreground">(optional)</span>
            </h3>
            <p className="text-xs text-muted-foreground">
              Fill these in once the post is live. They are not used
              to publish — v1 doesn&apos;t auto-post to any platform
              (SPEC.md §8.2.2).
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              control={form.control}
              name="externalId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Platform post ID</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="17912345678901234"
                      autoComplete="off"
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
              name="externalUrl"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>External URL</FormLabel>
                  <FormControl>
                    <Input
                      type="url"
                      inputMode="url"
                      placeholder="https://instagram.com/p/…"
                      autoComplete="off"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <FormField
          control={form.control}
          name="ownerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={isSubmitting || ownerOptions.length <= 1}
              >
                <FormControl>
                  <SelectTrigger className="sm:max-w-sm">
                    <SelectValue />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {ownerOptions.map((o) => (
                    <SelectItem key={o.id} value={o.id}>
                      {o.label}
                      {o.id === currentUserId ? ' (you)' : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => router.push('/social')}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2
                  className="h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
                <span>Creating…</span>
              </>
            ) : (
              'Create post'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
