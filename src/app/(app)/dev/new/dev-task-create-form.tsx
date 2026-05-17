'use client';

/**
 * DevTaskCreateForm — `react-hook-form` + zod form for `POST /api/dev/
 * tasks` (SPEC.md §9.1, §9.2.5).
 *
 * Mirrors the API's `devTaskCreateSchema` so client and server validate
 * the same shape. On submit:
 *   1. POSTs JSON to `/api/dev/tasks`.
 *   2. On success → toast + redirect to `/dev` (the kanban).
 *   3. On 4xx/5xx → toast the error and stay on the form.
 *
 * Field-level notes:
 *   • `title` is the only universally-required field.
 *   • `type` defaults to FEATURE; switching to BUG reveals the
 *     `affectsVersion` + `stepsToReproduce` fields, switching to
 *     RELEASE reveals `releaseVersion` + `releasedAt` + `platform`.
 *     The schema requires both releaseVersion + platform when type
 *     is RELEASE (SPEC.md §9.4 acceptance: "Create release v2.5.0
 *     with platform=iOS").
 *   • `assigneeId` defaults to the current user (SPEC.md §9.2.5
 *     "Assign to me default").
 *   • `targetWeek` is a single date input — we round to the
 *     containing Monday on submit so the roadmap groups land cleanly.
 *   • `releasedAt` is split across a date input and a time input for
 *     usability; combined into a UTC ISO string on submit.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { DevTaskStatus, DevTaskType, Priority } from '@prisma/client';
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

// ---------------------------------------------------------------------------
// Schema (client-side mirror of `devTaskCreateSchema`)
// ---------------------------------------------------------------------------

/**
 * Sentinel for the "Unassigned" option — Select can't render an
 * empty-string value. Translated to `undefined` (omitted) on submit.
 */
const ASSIGNEE_UNASSIGNED = '__unassigned__';

/**
 * Form-side schema. Slightly relaxed for UX:
 *   • Optional fields use `''` for "absent"; we strip on submit.
 *   • `releasedAt` is split (date + time) — combined on submit.
 *   • `targetWeek` is a single date input — rounded to Monday on
 *     submit.
 */
const formSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Title is required')
      .max(200, 'Title must be 200 characters or fewer'),
    description: z
      .string()
      .max(5000, 'Description must be 5000 characters or fewer')
      .optional()
      .or(z.literal('')),
    type: z.nativeEnum(DevTaskType),
    status: z.nativeEnum(DevTaskStatus),
    priority: z.nativeEnum(Priority),
    assigneeId: z.string(),
    targetWeek: z
      .string()
      .optional()
      .or(z.literal('')),
    affectsVersion: z
      .string()
      .trim()
      .max(100, 'Version must be 100 characters or fewer')
      .optional()
      .or(z.literal('')),
    stepsToReproduce: z
      .string()
      .max(5000, 'Steps must be 5000 characters or fewer')
      .optional()
      .or(z.literal('')),
    releaseVersion: z
      .string()
      .trim()
      .max(100, 'Version must be 100 characters or fewer')
      .optional()
      .or(z.literal('')),
    releasedAtDate: z.string().optional().or(z.literal('')),
    releasedAtTime: z.string().optional().or(z.literal('')),
    platform: z
      .string()
      .trim()
      .max(50, 'Platform must be 50 characters or fewer')
      .optional()
      .or(z.literal('')),
  })
  .refine(
    (val) =>
      val.type !== DevTaskType.RELEASE ||
      ((val.releaseVersion ?? '').trim() !== '' &&
        (val.platform ?? '').trim() !== ''),
    {
      message: 'Release version and platform are required for releases',
      path: ['releaseVersion'],
    },
  )
  .refine(
    (val) => !val.releasedAtTime || Boolean(val.releasedAtDate),
    {
      message: 'Pick a date for the release time',
      path: ['releasedAtDate'],
    },
  );

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedTask {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to create tasks here.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

const TYPE_LABELS: Record<DevTaskType, string> = {
  FEATURE: 'Feature',
  BUG: 'Bug',
  CHORE: 'Chore',
  RELEASE: 'Release',
};

const STATUS_LABELS: Record<DevTaskStatus, string> = {
  TODO: 'To do',
  DOING: 'Doing',
  DONE: 'Done',
};

const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const TYPE_VALUES = Object.keys(TYPE_LABELS) as DevTaskType[];
const STATUS_VALUES = Object.keys(STATUS_LABELS) as DevTaskStatus[];
const PRIORITY_VALUES = Object.keys(PRIORITY_LABELS) as Priority[];

const PLATFORM_PRESETS = ['iOS', 'Android', 'Web'] as const;

/**
 * Combine a YYYY-MM-DD date and HH:MM time into a UTC ISO string.
 * Time defaults to "12:00" so a date-only release lands at noon
 * rather than midnight (avoids the "wrong day" timezone footgun).
 */
function combineDateTime(date: string, time: string): string {
  const t = time.trim() === '' ? '12:00' : time;
  const local = new Date(`${date}T${t}:00`);
  return local.toISOString();
}

/**
 * Round a YYYY-MM-DD date to the Monday at 00:00 UTC of the same
 * ISO week, then return as an ISO string. Used for `targetWeek` so
 * the roadmap's Monday-aligned bucket math always matches.
 */
function toMondayOfWeek(date: string): string {
  if (!date) return '';
  // Parse as UTC midnight to avoid TZ shifts.
  const [y, m, d] = date.split('-').map((p) => Number(p));
  if (!y || !m || !d) return '';
  const utcMidnight = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
  const day = utcMidnight.getUTCDay();
  // Convert Sun(0)..Sat(6) → Mon(0)..Sun(6).
  const shift = (day + 6) % 7;
  utcMidnight.setUTCDate(utcMidnight.getUTCDate() - shift);
  return utcMidnight.toISOString();
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface AssigneeOption {
  id: string;
  label: string;
}

export interface DevTaskCreateFormProps {
  currentUserId: string;
  assigneeOptions: AssigneeOption[];
}

export function DevTaskCreateForm({
  currentUserId,
  assigneeOptions,
}: DevTaskCreateFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      title: '',
      description: '',
      type: DevTaskType.FEATURE,
      status: DevTaskStatus.TODO,
      priority: Priority.MEDIUM,
      // SPEC.md §9.2.5 — "Assign to me default".
      assigneeId: currentUserId,
      targetWeek: '',
      affectsVersion: '',
      stepsToReproduce: '',
      releaseVersion: '',
      releasedAtDate: '',
      releasedAtTime: '',
      platform: '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const watchedType = form.watch('type');
  const showBugFields = watchedType === DevTaskType.BUG;
  const showReleaseFields = watchedType === DevTaskType.RELEASE;

  async function onSubmit(values: FormValues) {
    // Build the API payload. Strip empty strings so optional fields
    // are absent rather than empty.
    const payload: Record<string, unknown> = {
      title: values.title.trim(),
      type: values.type,
      status: values.status,
      priority: values.priority,
    };

    const description = (values.description ?? '').trim();
    if (description !== '') payload.description = description;

    if (
      values.assigneeId &&
      values.assigneeId !== ASSIGNEE_UNASSIGNED
    ) {
      payload.assigneeId = values.assigneeId;
    }

    const targetWeek = (values.targetWeek ?? '').trim();
    if (targetWeek !== '') {
      payload.targetWeek = toMondayOfWeek(targetWeek);
    }

    if (showBugFields) {
      const affectsVersion = (values.affectsVersion ?? '').trim();
      if (affectsVersion !== '') payload.affectsVersion = affectsVersion;
      const stepsToReproduce = (values.stepsToReproduce ?? '').trim();
      if (stepsToReproduce !== '') payload.stepsToReproduce = stepsToReproduce;
    }

    if (showReleaseFields) {
      const releaseVersion = (values.releaseVersion ?? '').trim();
      if (releaseVersion !== '') payload.releaseVersion = releaseVersion;
      const platform = (values.platform ?? '').trim();
      if (platform !== '') payload.platform = platform;
      const releasedAtDate = (values.releasedAtDate ?? '').trim();
      if (releasedAtDate !== '') {
        payload.releasedAt = combineDateTime(
          releasedAtDate,
          (values.releasedAtTime ?? '').trim(),
        );
      }
    }

    let res: Response;
    try {
      res = await fetch('/api/dev/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | CreatedTask | null = null;
    try {
      body = (await res.json()) as ApiErrorBody | CreatedTask;
    } catch {
      body = null;
    }

    if (!res.ok) {
      toast.error(describeError(body as ApiErrorBody | null, res.status));
      return;
    }

    toast.success('Task created.');
    // Land on the kanban so the user can see their new task.
    // RELEASE entries land on the releases timeline instead.
    const target = values.type === DevTaskType.RELEASE ? '/dev/releases' : '/dev';
    router.replace(target);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-5"
        noValidate
      >
        <FormField
          control={form.control}
          name="title"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Title</FormLabel>
              <FormControl>
                <Input
                  placeholder="Short, scannable summary"
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
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Description{' '}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Textarea
                  rows={4}
                  maxLength={5000}
                  placeholder="More detail, links, screenshots…"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField
            control={form.control}
            name="type"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Type</FormLabel>
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
                    {TYPE_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {TYPE_LABELS[v]}
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
                    {STATUS_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {STATUS_LABELS[v]}
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
            name="priority"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Priority</FormLabel>
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
                    {PRIORITY_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {PRIORITY_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="assigneeId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Assignee</FormLabel>
                <Select
                  value={field.value || ASSIGNEE_UNASSIGNED}
                  onValueChange={field.onChange}
                  disabled={isSubmitting}
                >
                  <FormControl>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    <SelectItem value={ASSIGNEE_UNASSIGNED}>
                      Unassigned
                    </SelectItem>
                    {assigneeOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
                        {o.id === currentUserId ? ' (me)' : ''}
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
            name="targetWeek"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Target week{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="date"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Rounded to the Monday of that week on save.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        {/* BUG-specific fields */}
        {showBugFields ? (
          <div className="rounded-md border bg-muted/30 p-4 space-y-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Bug details
            </div>

            <FormField
              control={form.control}
              name="affectsVersion"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Affects version{' '}
                    <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      placeholder="e.g. v2.4.1"
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
              name="stepsToReproduce"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Steps to reproduce{' '}
                    <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      rows={4}
                      maxLength={5000}
                      placeholder="1. Open …&#10;2. Click …&#10;3. Observed: …"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>
        ) : null}

        {/* RELEASE-specific fields */}
        {showReleaseFields ? (
          <div className="rounded-md border bg-muted/30 p-4 space-y-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Release details
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="releaseVersion"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Release version</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. v2.5.0"
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
                name="platform"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Platform</FormLabel>
                    <FormControl>
                      <Input
                        list="dev-platform-presets"
                        placeholder="iOS, Android, Web…"
                        autoComplete="off"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    {/* Native datalist gives the three presets as
                        autocomplete suggestions while still allowing
                        a free-form typed value. */}
                    <datalist id="dev-platform-presets">
                      {PLATFORM_PRESETS.map((p) => (
                        <option key={p} value={p} />
                      ))}
                    </datalist>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="releasedAtDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Released on{' '}
                      <span className="text-muted-foreground">(optional)</span>
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
                name="releasedAtTime"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Time{' '}
                      <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="time"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <FormDescription>Defaults to 12:00 if blank.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => router.push('/dev')}
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
              'Create task'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
