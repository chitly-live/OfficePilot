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
import { Checkbox } from '@/components/ui/checkbox';
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
// v0.1.4 — phone-type options
// ---------------------------------------------------------------------------

/** Sentinel for the "no phone type chosen" Select item — Radix
 *  rejects empty-string values. Translated to `undefined` on submit. */
const PHONE_TYPE_NONE = '__none__';
const PHONE_TYPE_OPTIONS = ['iPhone', 'Android', 'Other'] as const;

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
    // v0.1.4 — spreadsheet fields
    age: z
      .string()
      .trim()
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => {
          if (!val) return true;
          const n = Number(val);
          return Number.isInteger(n) && n > 0 && n < 200;
        },
        'Age must be a whole number between 1 and 199',
      ),
    activeSince: z
      .string()
      .trim()
      .max(100, 'Active since must be 100 characters or fewer')
      .optional()
      .or(z.literal('')),
    languages: z
      .array(z.string())
      .max(20, 'A lead may have at most 20 languages'),
    extraDetails: z
      .string()
      .trim()
      .max(500, 'Extra details must be 500 characters or fewer')
      .optional()
      .or(z.literal('')),
    phoneType: z
      .union([
        z.literal(''),
        z.literal(PHONE_TYPE_NONE),
        z.enum(PHONE_TYPE_OPTIONS),
      ])
      .optional(),
    notOnWhatsapp: z.boolean(),
    address: z
      .string()
      .trim()
      .max(1000, 'Address must be 1000 characters or fewer')
      .optional()
      .or(z.literal('')),
    ownerId: z.string().min(1, 'Owner is required'),
    /**
     * Optional backdate for the lead's "Date" — when the lead actually
     * came in (matches the team's Excel "Date" column). Empty → server
     * uses `now()`. Stored as `YYYY-MM-DD`; combined to a Date at submit.
     */
    leadDate: z
      .string()
      .optional()
      .or(z.literal('')),
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
      leadDate: '',
      followUpDate: '',
      followUpTime: '',
      notes: '',
      // v0.1.4 — Profile (optional) section defaults.
      age: '',
      activeSince: '',
      languages: [],
      extraDetails: '',
      phoneType: PHONE_TYPE_NONE,
      notOnWhatsapp: false,
      address: '',
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

    // Optional lead "Date" override — backdate to when the lead actually
    // came in (matches Chitly's Excel "Date" column). Empty → server's now().
    const leadDate = (values.leadDate ?? '').trim();
    if (leadDate !== '') {
      // YYYY-MM-DD from the <input type="date"> becomes a midnight-IST-ish
      // ISO string. The API parses it via `isoDateTimeField`.
      payload.createdAt = new Date(`${leadDate}T00:00:00`).toISOString();
    }

    // v0.1.4 — Profile (optional) fields. Empty strings are stripped
    // so the API receives `undefined` for "absent" rather than `""`.
    const ageRaw = (values.age ?? '').trim();
    if (ageRaw !== '') payload.age = Number(ageRaw);

    const activeSince = (values.activeSince ?? '').trim();
    if (activeSince !== '') payload.activeSince = activeSince;

    if (values.languages.length > 0) payload.languages = values.languages;

    const extraDetails = (values.extraDetails ?? '').trim();
    if (extraDetails !== '') payload.extraDetails = extraDetails;

    const phoneTypeRaw = values.phoneType ?? '';
    if (phoneTypeRaw !== '' && phoneTypeRaw !== PHONE_TYPE_NONE) {
      payload.phoneType = phoneTypeRaw;
    }

    // Always send the boolean — its default is `false` and the API
    // schema treats `undefined` the same way, but being explicit
    // means a future schema change can rely on the field's presence.
    if (values.notOnWhatsapp === true) payload.notOnWhatsapp = true;

    const address = (values.address ?? '').trim();
    if (address !== '') payload.address = address;

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

        <FormField
          control={form.control}
          name="address"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Address{' '}
                <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Textarea
                  rows={2}
                  placeholder={'Pune, Maharashtra'}
                  autoComplete="off"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormDescription>
                Free-form — city, state, country, anything that helps the
                team place this lead.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="value"
          render={({ field }) => (
            <FormItem className="sm:max-w-sm">
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

        {/* Legacy `city` is intentionally hidden in the create form —
            the new `address` field replaces it for fresh entries. */}

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

        {/* ----------------------------------------------------------
             v0.1.4 — Profile (optional) section.
             Mirrors the Chitly team's Excel columns so admins can
             capture all the spreadsheet context without switching
             tools.
             ---------------------------------------------------------- */}
        <fieldset className="space-y-4 rounded-md border bg-muted/30 p-4">
          <legend className="px-1 text-sm font-medium text-foreground">
            Profile{' '}
            <span className="text-muted-foreground">(optional)</span>
          </legend>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="age"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Age</FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={199}
                      step={1}
                      placeholder="29"
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
              name="activeSince"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Active Since</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="10 Days, 6 months, etc."
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
              name="phoneType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Phone Type</FormLabel>
                  <Select
                    value={
                      field.value === '' || field.value === undefined
                        ? PHONE_TYPE_NONE
                        : field.value
                    }
                    onValueChange={field.onChange}
                    disabled={isSubmitting}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="(none)" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value={PHONE_TYPE_NONE}>(none)</SelectItem>
                      {PHONE_TYPE_OPTIONS.map((v) => (
                        <SelectItem key={v} value={v}>
                          {v}
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
            name="languages"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Languages</FormLabel>
                <FormControl>
                  <TagsInput
                    value={field.value}
                    onChange={field.onChange}
                    disabled={isSubmitting}
                    placeholder="Press Enter to add (e.g. Hindi, English)"
                    maxTags={20}
                  />
                </FormControl>
                <FormDescription>
                  Free text — no whitelist. The filter bar will pick up new
                  values automatically.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="extraDetails"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Extra Details</FormLabel>
                <FormControl>
                  <Input
                    placeholder="IT Job - Unmarried - Finding Someone"
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
            name="notOnWhatsapp"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox
                    id="lead-create-not-whatsapp"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={isSubmitting}
                  />
                </FormControl>
                <FormLabel
                  htmlFor="lead-create-not-whatsapp"
                  className="cursor-pointer text-sm font-normal"
                >
                  Not on WhatsApp
                </FormLabel>
                <FormMessage />
              </FormItem>
            )}
          />
        </fieldset>

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

        <FormField
          control={form.control}
          name="leadDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Date{' '}
                <span className="text-muted-foreground">
                  (when the lead came in — leave blank for today)
                </span>
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
