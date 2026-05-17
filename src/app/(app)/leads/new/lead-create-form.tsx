'use client';

/**
 * LeadCreateForm — `react-hook-form` + zod form for `POST /api/leads`.
 *
 * Mirrors the API's `leadCreateSchema` so client and server validate
 * the same shape. On submit:
 *   1. POSTs JSON to `/api/leads`.
 *   2. On success → redirect to `/leads/[id]` (the new row).
 *   3. On 4xx/5xx → toast the error and stay on the form.
 *
 * Field-level notes:
 *   • `name` is the only universally-required field; the schema also
 *     asserts `phone || email` so we cross-validate on the form side
 *     too (SPEC §6.4).
 *   • `value` is INR; the input is `type="number"` and we send
 *     `undefined` when blank so the column stays NULL.
 *   • `tags` is a multi-input — see `TagsInput` below — and serialises
 *     to a `string[]` payload.
 *   • `ownerId` is constrained server-side: EMPLOYEEs can only assign
 *     to themselves. We mirror that by limiting the dropdown options
 *     in the parent page; the API enforces it regardless.
 *   • `nextFollowUpAt` is split across a date input and a time input
 *     for usability; we combine them into a local-tz ISO string on
 *     submit.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { LeadSource, Priority, type Role } from '@prisma/client';
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

// ---------------------------------------------------------------------------
// Schema (client-side mirror of `leadCreateSchema`)
// ---------------------------------------------------------------------------

/** Same regex as `leadCreateSchema`. */
const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

/**
 * Form-side schema. Slightly relaxed for UX:
 *   • Optional fields use `''` to mean "absent"; we strip on submit.
 *   • `value` is a string (from the input element) coerced to a
 *     number when non-empty.
 *   • `nextFollowUpAt` is split (date + time) — we combine on submit.
 */
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
    ownerId: z.string().min(1, 'Owner is required'),
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

interface CreatedLead {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to create leads here.';
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

const PRIORITY_LABELS: Record<Priority, string> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  URGENT: 'Urgent',
};

const SOURCE_VALUES = Object.keys(SOURCE_LABELS) as LeadSource[];
const PRIORITY_VALUES = Object.keys(PRIORITY_LABELS) as Priority[];

/**
 * Combine a YYYY-MM-DD date and HH:MM time into a UTC ISO string.
 * Time defaults to "09:00" (a sensible business-hours follow-up) so
 * an admin who only picks a date doesn't get a midnight reminder.
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

export interface LeadCreateFormProps {
  currentUserId: string;
  currentUserRole: Role;
  ownerOptions: OwnerOption[];
}

export function LeadCreateForm({
  currentUserId,
  ownerOptions,
}: LeadCreateFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      phone: '',
      email: '',
      company: '',
      city: '',
      source: LeadSource.MANUAL,
      priority: Priority.MEDIUM,
      value: '',
      tags: [],
      ownerId: currentUserId,
      followUpDate: '',
      followUpTime: '',
      notes: '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: FormValues) {
    // Build the API payload by stripping empty strings so optional
    // fields are absent (NULL) rather than empty.
    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      source: values.source,
      priority: values.priority,
      tags: values.tags,
      ownerId: values.ownerId,
    };

    const phone = (values.phone ?? '').trim();
    if (phone !== '') payload.phone = phone;

    const email = (values.email ?? '').trim();
    if (email !== '') payload.email = email;

    const company = (values.company ?? '').trim();
    if (company !== '') payload.company = company;

    const city = (values.city ?? '').trim();
    if (city !== '') payload.city = city;

    const valueRaw = (values.value ?? '').trim();
    if (valueRaw !== '') payload.value = Number(valueRaw);

    const notes = (values.notes ?? '').trim();
    if (notes !== '') payload.notes = notes;

    const followUpDate = (values.followUpDate ?? '').trim();
    if (followUpDate !== '') {
      payload.nextFollowUpAt = combineDateTime(
        followUpDate,
        (values.followUpTime ?? '').trim(),
      );
    }

    let res: Response;
    try {
      res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | CreatedLead | null = null;
    try {
      body = (await res.json()) as ApiErrorBody | CreatedLead;
    } catch {
      body = null;
    }

    if (!res.ok) {
      toast.error(describeError(body as ApiErrorBody | null, res.status));
      return;
    }

    const created = body as CreatedLead | null;
    if (!created?.id) {
      toast.error('Unexpected response from the server.');
      return;
    }

    toast.success('Lead created.');
    router.replace(`/leads/${created.id}`);
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
                    placeholder="Riya Kapoor"
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
            name="company"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Company{' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="Acme Pvt Ltd"
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
                    placeholder="+91 98765 43210"
                    autoComplete="off"
                    disabled={isSubmitting}
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
                    placeholder="riya@example.com"
                    autoComplete="off"
                    disabled={isSubmitting}
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
                    placeholder="Mumbai"
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
                    placeholder="50000"
                    disabled={isSubmitting}
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
            name="source"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Source</FormLabel>
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
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                  </FormControl>
                  <SelectContent>
                    {ownerOptions.map((o) => (
                      <SelectItem key={o.id} value={o.id}>
                        {o.label}
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
                  disabled={isSubmitting}
                  placeholder="Press Enter to add (e.g. hot, demo-requested)"
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
                    disabled={isSubmitting}
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
                  placeholder="Anything we should remember about this lead…"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => router.push('/leads')}
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
              'Create lead'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
