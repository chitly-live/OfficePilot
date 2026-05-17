'use client';

/**
 * LeadEditForm — `react-hook-form` + zod form for
 * `PATCH /api/leads/[id]`.
 *
 * Mirrors the API's `leadUpdateSchema` so client and server validate
 * the same shape. The form is "diff-based": on submit we send only
 * the fields that actually changed against `initialValues`. This:
 *
 *   • Keeps activity log noise low — a no-op submit doesn't fire
 *     `lead.updated`.
 *   • Lets us route through the API's status / convert / assigned
 *     log paths cleanly (the route inspects which fields changed).
 *
 * Authorisation:
 *   • The API enforces "ADMIN or owner/creator" for any PATCH (SPEC
 *     §2.1, §6.4); the parent page passes `canEdit` so we render
 *     read-only inputs when the current user can't write.
 *   • Only ADMIN may reassign to another user. EMPLOYEE-self can
 *     "self-assign" but we render the owner select disabled when
 *     `!isAdmin` to make the constraint visible.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { LeadSource, LeadStatus, Priority } from '@prisma/client';
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

import { TagsInput } from '../tags-input';
import type { OwnerOption } from '../new/lead-create-form';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel option value for the "unassigned" owner choice. shadcn
 *  `Select` rejects empty string as an item value, so we use a
 *  sentinel and translate it to `null` on submit. */
const OWNER_UNASSIGNED = '__unassigned__';

const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const formSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(200, 'Name must be 200 characters or fewer'),
    phone: z
      .string()
      .trim()
      .max(32, 'Phone must be 32 characters or fewer')
      .refine(
        (val) => val === '' || phoneRegex.test(val),
        'Invalid phone number',
      )
      .refine(
        (val) =>
          val === '' || (val.match(/\d/g)?.length ?? 0) >= 7,
        'Phone must contain at least 7 digits',
      )
      .optional()
      .or(z.literal('')),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254, 'Email must be 254 characters or fewer')
      .refine(
        (val) => val === '' || /^\S+@\S+\.\S+$/.test(val),
        'Invalid email address',
      )
      .optional()
      .or(z.literal('')),
    company: z
      .string()
      .trim()
      .max(200, 'Company must be 200 characters or fewer')
      .optional()
      .or(z.literal('')),
    city: z
      .string()
      .trim()
      .max(100, 'City must be 100 characters or fewer')
      .optional()
      .or(z.literal('')),
    source: z.nativeEnum(LeadSource),
    status: z.nativeEnum(LeadStatus),
    priority: z.nativeEnum(Priority),
    value: z
      .string()
      .trim()
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => {
          if (!val) return true;
          const n = Number(val);
          return Number.isFinite(n) && n >= 0;
        },
        'Value must be a non-negative number',
      ),
    tags: z.array(z.string()).max(30, 'A lead may have at most 30 tags'),
    /** Sentinel `OWNER_UNASSIGNED` means "no owner". */
    ownerId: z.string().min(1),
    followUpDate: z
      .string()
      .optional()
      .or(z.literal('')),
    followUpTime: z
      .string()
      .optional()
      .or(z.literal('')),
    notes: z
      .string()
      .max(5000, 'Notes must be 5000 characters or fewer')
      .optional()
      .or(z.literal('')),
  })
  .refine(
    (val) =>
      (val.phone && val.phone.trim() !== '') ||
      (val.email && val.email.trim() !== ''),
    { message: 'Either phone or email is required', path: ['phone'] },
  )
  .refine(
    (val) => !val.followUpTime || Boolean(val.followUpDate),
    {
      message: 'Pick a date for the follow-up time',
      path: ['followUpDate'],
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
  if (status === 403) return 'You are not allowed to edit this lead.';
  if (status === 404) return 'Lead not found.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

const SOURCE_LABELS: Record<LeadSource, string> = {
  WEBSITE: 'Website',
  WHATSAPP: 'WhatsApp',
  FACEBOOK_AD: 'Facebook Ad',
  GOOGLE_AD: 'Google Ad',
  INSTAGRAM: 'Instagram',
  REFERRAL: 'Referral',
  MANUAL: 'Manual',
  OTHER: 'Other',
};

const STATUS_LABELS: Record<LeadStatus, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  INTERESTED: 'Interested',
  FOLLOW_UP: 'Follow up',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const SOURCE_VALUES = Object.keys(SOURCE_LABELS) as LeadSource[];
const STATUS_VALUES = Object.keys(STATUS_LABELS) as LeadStatus[];
const PRIORITY_VALUES = Object.keys(PRIORITY_LABELS) as Priority[];

/**
 * Combine a YYYY-MM-DD date and HH:MM time into a UTC ISO string.
 * Time defaults to "09:00" if blank.
 */
function combineDateTime(date: string, time: string): string {
  const t = time.trim() === '' ? '09:00' : time;
  const local = new Date(`${date}T${t}:00`);
  return local.toISOString();
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface LeadEditFormProps {
  leadId: string;
  isAdmin: boolean;
  /** When false, every field renders disabled — read-only fallback. */
  canEdit: boolean;
  currentUserId: string;
  ownerOptions: OwnerOption[];
  initialValues: {
    name: string;
    phone: string | null;
    email: string | null;
    company: string | null;
    city: string | null;
    source: LeadSource;
    status: LeadStatus;
    priority: Priority;
    value: number | null;
    tags: string[];
    ownerId: string | null;
    /** YYYY-MM-DD or empty string. */
    followUpDate: string;
    /** HH:MM or empty string. */
    followUpTime: string;
    notes: string | null;
  };
}

export function LeadEditForm({
  leadId,
  isAdmin,
  canEdit,
  currentUserId,
  ownerOptions,
  initialValues,
}: LeadEditFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialValues.name,
      phone: initialValues.phone ?? '',
      email: initialValues.email ?? '',
      company: initialValues.company ?? '',
      city: initialValues.city ?? '',
      source: initialValues.source,
      status: initialValues.status,
      priority: initialValues.priority,
      value:
        initialValues.value === null || initialValues.value === undefined
          ? ''
          : String(initialValues.value),
      tags: initialValues.tags,
      ownerId: initialValues.ownerId ?? OWNER_UNASSIGNED,
      followUpDate: initialValues.followUpDate,
      followUpTime: initialValues.followUpTime,
      notes: initialValues.notes ?? '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const formDisabled = !canEdit || isSubmitting;

  async function onSubmit(values: FormValues) {
    // Build the PATCH body by diffing against initialValues. Empty
    // string in the form means "clear this nullable string column"
    // for fields the schema accepts as nullable; the schema for
    // those fields uses `.nullable().optional()`, so we send `null`
    // explicitly when the user blanks the input.
    const payload: Record<string, unknown> = {};

    const nameTrim = values.name.trim();
    if (nameTrim !== initialValues.name) payload.name = nameTrim;

    const phoneTrim = (values.phone ?? '').trim();
    const initPhone = initialValues.phone ?? '';
    if (phoneTrim !== initPhone) {
      payload.phone = phoneTrim === '' ? null : phoneTrim;
    }

    const emailTrim = (values.email ?? '').trim();
    const initEmail = initialValues.email ?? '';
    if (emailTrim !== initEmail) {
      payload.email = emailTrim === '' ? null : emailTrim;
    }

    const companyTrim = (values.company ?? '').trim();
    const initCompany = initialValues.company ?? '';
    if (companyTrim !== initCompany) {
      payload.company = companyTrim === '' ? null : companyTrim;
    }

    const cityTrim = (values.city ?? '').trim();
    const initCity = initialValues.city ?? '';
    if (cityTrim !== initCity) {
      payload.city = cityTrim === '' ? null : cityTrim;
    }

    if (values.source !== initialValues.source) payload.source = values.source;
    if (values.status !== initialValues.status) payload.status = values.status;
    if (values.priority !== initialValues.priority) {
      payload.priority = values.priority;
    }

    const valueRaw = (values.value ?? '').trim();
    const initValue = initialValues.value;
    if (valueRaw === '' && initValue !== null) {
      payload.value = null;
    } else if (valueRaw !== '' && Number(valueRaw) !== initValue) {
      payload.value = Number(valueRaw);
    }

    // Tag arrays: deep equality on the order-sensitive list. Matching
    // the schema's `string[]` semantics (order is preserved).
    const tagsChanged =
      values.tags.length !== initialValues.tags.length ||
      values.tags.some((t, i) => t !== initialValues.tags[i]);
    if (tagsChanged) payload.tags = values.tags;

    const ownerIdNext =
      values.ownerId === OWNER_UNASSIGNED ? null : values.ownerId;
    if (ownerIdNext !== (initialValues.ownerId ?? null)) {
      payload.ownerId = ownerIdNext;
    }

    // Follow-up date+time: combine and compare ISO strings.
    const followUpDateNext = (values.followUpDate ?? '').trim();
    const followUpTimeNext = (values.followUpTime ?? '').trim();
    const initFollowUpIso =
      initialValues.followUpDate !== ''
        ? combineDateTime(
            initialValues.followUpDate,
            initialValues.followUpTime,
          )
        : null;
    const nextFollowUpIso =
      followUpDateNext !== ''
        ? combineDateTime(followUpDateNext, followUpTimeNext)
        : null;
    if (nextFollowUpIso !== initFollowUpIso) {
      payload.nextFollowUpAt = nextFollowUpIso;
    }

    const notesTrim = (values.notes ?? '').trim();
    const initNotes = initialValues.notes ?? '';
    if (notesTrim !== initNotes) {
      payload.notes = notesTrim === '' ? null : notesTrim;
    }

    if (Object.keys(payload).length === 0) {
      toast.info('No changes to save.');
      return;
    }

    let res: Response;
    try {
      res = await fetch(`/api/leads/${leadId}`, {
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

    toast.success('Lead updated.');
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
            name="name"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Name</FormLabel>
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
            name="company"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Company{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
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
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="phone"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Phone</FormLabel>
                <FormControl>
                  <Input
                    type="tel"
                    autoComplete="off"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Phone or email is required.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    type="email"
                    autoComplete="off"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Phone or email is required.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="city"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  City <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
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
            name="value"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Estimated value (₹){' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
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
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source</FormLabel>
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
                    {SOURCE_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {SOURCE_LABELS[v]}
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
                  disabled={formDisabled}
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
                  <SelectItem value={OWNER_UNASSIGNED}>Unassigned</SelectItem>
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
                  Only admins can reassign leads.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="tags"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Tags <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <TagsInput
                  value={field.value}
                  onChange={field.onChange}
                  disabled={formDisabled}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="followUpDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Next follow-up date{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
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
            name="followUpTime"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Time{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="time"
                    disabled={formDisabled}
                    {...field}
                  />
                </FormControl>
                <FormDescription>Defaults to 09:00 if blank.</FormDescription>
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
                  rows={4}
                  maxLength={5000}
                  disabled={formDisabled}
                  {...field}
                />
              </FormControl>
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
