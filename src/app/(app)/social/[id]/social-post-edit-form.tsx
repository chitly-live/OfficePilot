'use client';

/**
 * SocialPostEditForm — `react-hook-form` + zod form for
 * `PATCH /api/social/posts/[id]` (SPEC.md §8.2.2, §8.2.3, §8.2.4).
 *
 * Mirrors the API's `socialPostUpdateSchema` so client and server
 * validate the same shape. The form is "diff-based": on submit we
 * send only the fields that actually changed against `initialValues`.
 * This:
 *
 *   • Keeps activity log noise low — a no-op submit doesn't fire a
 *     `socialpost.updated` row.
 *   • Lets the API's published / winner / generic-update log paths
 *     fire correctly (the route inspects which fields changed).
 *
 * Authorisation:
 *   • The API enforces "ADMIN or owner" for any PATCH (SPEC.md §2.1,
 *     §8); the parent page passes `canEdit` so we render read-only
 *     inputs when the current user can't write.
 *   • Only ADMIN may reassign to another user.
 *
 * The performance counters (likes/comments/shares/reach/impressions)
 * live on this single form alongside the editorial fields. SPEC.md
 * §8.2.3 frames performance entry as "manually update" — there's no
 * separate performance form in v1, so the same diff path handles it.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { PostStatus, SocialPlatform } from '@prisma/client';
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
import type { OwnerOption } from '../new/social-post-create-form';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Generic non-negative integer string field (likes/comments/…). */
const counterField = z
  .string()
  .trim()
  .refine(
    (val) => {
      if (val === '') return false;
      const n = Number(val);
      return Number.isFinite(n) && Number.isInteger(n) && n >= 0;
    },
    'Must be a non-negative integer',
  );

const formSchema = z
  .object({
    platform: z.nativeEnum(SocialPlatform),
    status: z.nativeEnum(PostStatus),
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
    scheduledTime: z.string().optional().or(z.literal('')),
    publishedDate: z
      .string()
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => !val || !Number.isNaN(new Date(val).getTime()),
        'Invalid date',
      ),
    publishedTime: z.string().optional().or(z.literal('')),
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
    likes: counterField,
    comments: counterField,
    shares: counterField,
    reach: counterField,
    impressions: counterField,
    isWinner: z.boolean(),
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

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to edit this post.';
  if (status === 404) return 'Post not found.';
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

const STATUS_LABELS: Record<PostStatus, string> = {
  DRAFT: 'Draft',
  SCHEDULED: 'Scheduled',
  PUBLISHED: 'Published',
  FAILED: 'Failed',
};

const PLATFORM_VALUES = Object.keys(PLATFORM_LABELS) as SocialPlatform[];
const STATUS_VALUES = Object.keys(STATUS_LABELS) as PostStatus[];

/**
 * Combine a YYYY-MM-DD date and HH:MM time into a UTC ISO string.
 * Time defaults to "09:00" so an editor who only picks a date doesn't
 * get a midnight timestamp.
 */
function combineDateTime(date: string, time: string): string {
  const t = time.trim() === '' ? '09:00' : time;
  const local = new Date(`${date}T${t}:00`);
  return local.toISOString();
}

/** Convert a Date / ISO string to YYYY-MM-DD in the viewer's local TZ. */
function toLocalDateInput(value: Date | string | null): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Convert a Date / ISO string to HH:MM in the viewer's local TZ. */
function toLocalTimeInput(value: Date | string | null): string {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Compare two date-ish values for equality after normalising to ISO. */
function sameDate(
  next: string | null,
  initial: Date | string | null,
): boolean {
  const initIso = initial ? new Date(initial).toISOString() : null;
  return next === initIso;
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface SocialPostEditFormProps {
  postId: string;
  isAdmin: boolean;
  /** When false, every field renders disabled — read-only fallback. */
  canEdit: boolean;
  currentUserId: string;
  ownerOptions: OwnerOption[];
  /**
   * Saved hashtag sets from `Setting('hashtag_sets')` — rendered as
   * quick-paste buttons above the hashtag chip input. Optional; when
   * empty/undefined the buttons are hidden (SPEC.md §8.2 #5).
   */
  hashtagSets?: HashtagSet[];
  initialValues: {
    platform: SocialPlatform;
    status: PostStatus;
    caption: string;
    mediaUrls: string[];
    hashtags: string[];
    scheduledAt: Date | string | null;
    publishedAt: Date | string | null;
    externalId: string | null;
    externalUrl: string | null;
    likes: number;
    comments: number;
    shares: number;
    reach: number;
    impressions: number;
    isWinner: boolean;
    ownerId: string;
  };
}

export function SocialPostEditForm({
  postId,
  isAdmin,
  canEdit,
  currentUserId,
  ownerOptions,
  hashtagSets,
  initialValues,
}: SocialPostEditFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      platform: initialValues.platform,
      status: initialValues.status,
      caption: initialValues.caption,
      mediaUrls: initialValues.mediaUrls,
      hashtags: initialValues.hashtags,
      scheduledDate: toLocalDateInput(initialValues.scheduledAt),
      scheduledTime: toLocalTimeInput(initialValues.scheduledAt),
      publishedDate: toLocalDateInput(initialValues.publishedAt),
      publishedTime: toLocalTimeInput(initialValues.publishedAt),
      externalId: initialValues.externalId ?? '',
      externalUrl: initialValues.externalUrl ?? '',
      likes: String(initialValues.likes),
      comments: String(initialValues.comments),
      shares: String(initialValues.shares),
      reach: String(initialValues.reach),
      impressions: String(initialValues.impressions),
      isWinner: initialValues.isWinner,
      ownerId: initialValues.ownerId,
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const formDisabled = !canEdit || isSubmitting;

  async function onSubmit(values: FormValues) {
    // Diff against `initialValues`. Empty strings → null for nullable
    // columns so the column is cleared rather than set to ''.
    const payload: Record<string, unknown> = {};

    if (values.platform !== initialValues.platform) {
      payload.platform = values.platform;
    }
    if (values.status !== initialValues.status) {
      payload.status = values.status;
    }

    const captionTrim = values.caption.trim();
    if (captionTrim !== initialValues.caption) payload.caption = captionTrim;

    // Array equality: same length AND same elements in the same order.
    const sameArray = (a: string[], b: string[]) =>
      a.length === b.length && a.every((v, i) => v === b[i]);
    if (!sameArray(values.mediaUrls, initialValues.mediaUrls)) {
      payload.mediaUrls = values.mediaUrls;
    }
    if (!sameArray(values.hashtags, initialValues.hashtags)) {
      payload.hashtags = values.hashtags;
    }

    // scheduledAt: combine date + time, compare ISO. Empty date → null.
    const scheduleNext =
      (values.scheduledDate ?? '').trim() === ''
        ? null
        : combineDateTime(
            (values.scheduledDate ?? '').trim(),
            (values.scheduledTime ?? '').trim(),
          );
    if (!sameDate(scheduleNext, initialValues.scheduledAt)) {
      payload.scheduledAt = scheduleNext;
    }

    // publishedAt: same treatment. Note that the API also auto-stamps
    // this when status crosses to PUBLISHED — sending `null` here on a
    // publish would clobber that, so we only forward the field when it
    // changed AND the status isn't transitioning to PUBLISHED-with-
    // empty-published-input. The route handles "no publishedAt
    // provided + status flips to PUBLISHED" correctly.
    const publishedNext =
      (values.publishedDate ?? '').trim() === ''
        ? null
        : combineDateTime(
            (values.publishedDate ?? '').trim(),
            (values.publishedTime ?? '').trim(),
          );
    if (!sameDate(publishedNext, initialValues.publishedAt)) {
      payload.publishedAt = publishedNext;
    }

    const externalIdNext = (values.externalId ?? '').trim();
    const initExternalId = initialValues.externalId ?? '';
    if (externalIdNext !== initExternalId) {
      payload.externalId = externalIdNext === '' ? null : externalIdNext;
    }

    const externalUrlNext = (values.externalUrl ?? '').trim();
    const initExternalUrl = initialValues.externalUrl ?? '';
    if (externalUrlNext !== initExternalUrl) {
      payload.externalUrl = externalUrlNext === '' ? null : externalUrlNext;
    }

    const likesNext = Number(values.likes);
    if (likesNext !== initialValues.likes) payload.likes = likesNext;
    const commentsNext = Number(values.comments);
    if (commentsNext !== initialValues.comments) payload.comments = commentsNext;
    const sharesNext = Number(values.shares);
    if (sharesNext !== initialValues.shares) payload.shares = sharesNext;
    const reachNext = Number(values.reach);
    if (reachNext !== initialValues.reach) payload.reach = reachNext;
    const impressionsNext = Number(values.impressions);
    if (impressionsNext !== initialValues.impressions) {
      payload.impressions = impressionsNext;
    }

    if (values.isWinner !== initialValues.isWinner) {
      payload.isWinner = values.isWinner;
    }

    if (values.ownerId !== initialValues.ownerId) {
      payload.ownerId = values.ownerId;
    }

    if (Object.keys(payload).length === 0) {
      toast.info('No changes to save.');
      return;
    }

    let res: Response;
    try {
      res = await fetch(`/api/social/posts/${postId}`, {
        method: 'PATCH',
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

    toast.success('Post updated.');
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
                  disabled={formDisabled}
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
                  disabled={formDisabled}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {STATUS_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {STATUS_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Switching to <strong>Published</strong> auto-stamps
                  the publish time if you leave it blank.
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
                  disabled={formDisabled}
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
                  disabled={formDisabled}
                />
              </FormControl>
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
                  disabled={formDisabled}
                  sets={hashtagSets}
                />
              </FormControl>
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
                <FormLabel>Schedule date</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={formDisabled}
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
                <FormLabel>Schedule time</FormLabel>
                <FormControl>
                  <Input
                    type="time"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="publishedDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Published date</FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Auto-set the first time you mark the post Published.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="publishedTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Published time</FormLabel>
                <FormControl>
                  <Input
                    type="time"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
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
              Paste the live URL after publishing. SPEC.md §8.2.2 — v1
              doesn&apos;t auto-publish to any platform.
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
                      autoComplete="off"
                      disabled={formDisabled}
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
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        </div>

        <div className="space-y-3 rounded-md border bg-muted/20 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              Performance
            </h3>
            <p className="text-xs text-muted-foreground">
              Manually update these after the post is live (SPEC.md
              §8.2.3). Used to compute engagement totals and the top-
              performing post on `/social/winners` + the stats card.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
            <FormField
              control={form.control}
              name="likes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Likes</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="comments"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Comments</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="shares"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Shares</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="reach"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Reach</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="impressions"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Impressions</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={0}
                      step={1}
                      disabled={formDisabled}
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
          name="isWinner"
          render={({ field }) => (
            <FormItem className="flex items-start gap-3 rounded-md border p-3">
              <FormControl>
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-input text-primary focus:ring-ring"
                  checked={field.value}
                  onChange={(e) => field.onChange(e.target.checked)}
                  disabled={formDisabled}
                />
              </FormControl>
              <div className="space-y-0.5">
                <FormLabel className="text-sm">Mark as winner</FormLabel>
                <FormDescription>
                  Winners surface on{' '}
                  <code>/social/winners</code> as inspiration for
                  future posts (SPEC.md §8.2.4).
                </FormDescription>
              </div>
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="ownerId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Owner</FormLabel>
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={formDisabled || !isAdmin}
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
              {!isAdmin ? (
                <FormDescription>
                  Only admins can reassign posts.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

        {canEdit ? (
          <div className="flex items-center justify-end gap-2 pt-2">
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
                'Save changes'
              )}
            </Button>
          </div>
        ) : null}
      </form>
    </Form>
  );
}
