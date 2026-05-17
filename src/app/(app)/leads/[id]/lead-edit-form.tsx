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
import type { OwnerOption } from '../new/lead-create-form';

// ---------------------------------------------------------------------------
// v0.1.4 — phone-type options
// ---------------------------------------------------------------------------

/** Sentinel for the "(none)" Select item — Radix rejects empty-string
 *  values. Translated to `null` on submit. */
const PHONE_TYPE_NONE = '__none__';
const PHONE_TYPE_OPTIONS = ['iPhone', 'Android', 'Other'] as const;

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
    // v0.1.4 — spreadsheet fields. Identical shape to lead-create-form.
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
    /** Sentinel `OWNER_UNASSIGNED` means "no owner". */
    ownerId: z.string().min(1),
    /** Backdate override — when the lead actually came in. */
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
    /** YYYY-MM-DD form of the lead's current `createdAt` for backdate editing. */
    leadDate: string;
    /** YYYY-MM-DD or empty string. */
    followUpDate: string;
    /** HH:MM or empty string. */
    followUpTime: string;
    notes: string | null;
    // v0.1.4 — spreadsheet fields. All optional (older rows pre-date
    // the migration); pre-populated from the lead's current values.
    age?: number | null;
    activeSince?: string | null;
    languages?: string[];
    extraDetails?: string | null;
    phoneType?: string | null;
    notOnWhatsapp?: boolean;
    address?: string | null;
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
      leadDate: initialValues.leadDate,
      followUpDate: initialValues.followUpDate,
      followUpTime: initialValues.followUpTime,
      notes: initialValues.notes ?? '',
      // v0.1.4 — Profile section defaults from the existing lead.
      age:
        initialValues.age === null || initialValues.age === undefined
          ? ''
          : String(initialValues.age),
      activeSince: initialValues.activeSince ?? '',
      languages: initialValues.languages ?? [],
      extraDetails: initialValues.extraDetails ?? '',
      phoneType:
        initialValues.phoneType &&
        (PHONE_TYPE_OPTIONS as readonly string[]).includes(
          initialValues.phoneType,
        )
          ? (initialValues.phoneType as (typeof PHONE_TYPE_OPTIONS)[number])
          : PHONE_TYPE_NONE,
      notOnWhatsapp: initialValues.notOnWhatsapp ?? false,
      address: initialValues.address ?? '',
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

    // Backdate "Date" override — only PATCH when the YYYY-MM-DD differs
    // from the lead's current `createdAt` calendar date. Empty leadDate
    // means "leave it alone"; we never send the wire-clearing `null` here.
    const leadDateNext = (values.leadDate ?? '').trim();
    if (leadDateNext !== '' && leadDateNext !== initialValues.leadDate) {
      payload.createdAt = new Date(`${leadDateNext}T00:00:00`).toISOString();
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

    // -------- v0.1.4 Profile fields --------

    const ageRaw = (values.age ?? '').trim();
    const initAge = initialValues.age ?? null;
    if (ageRaw === '' && initAge !== null) {
      payload.age = null;
    } else if (ageRaw !== '' && Number(ageRaw) !== initAge) {
      payload.age = Number(ageRaw);
    }

    const activeSinceTrim = (values.activeSince ?? '').trim();
    const initActiveSince = initialValues.activeSince ?? '';
    if (activeSinceTrim !== initActiveSince) {
      payload.activeSince = activeSinceTrim === '' ? null : activeSinceTrim;
    }

    const initLanguages = initialValues.languages ?? [];
    const languagesChanged =
      values.languages.length !== initLanguages.length ||
      values.languages.some((l, i) => l !== initLanguages[i]);
    if (languagesChanged) payload.languages = values.languages;

    const extraDetailsTrim = (values.extraDetails ?? '').trim();
    const initExtraDetails = initialValues.extraDetails ?? '';
    if (extraDetailsTrim !== initExtraDetails) {
      payload.extraDetails =
        extraDetailsTrim === '' ? null : extraDetailsTrim;
    }

    const phoneTypeRaw = values.phoneType ?? '';
    const phoneTypeNext =
      phoneTypeRaw === '' || phoneTypeRaw === PHONE_TYPE_NONE
        ? null
        : phoneTypeRaw;
    if (phoneTypeNext !== (initialValues.phoneType ?? null)) {
      payload.phoneType = phoneTypeNext;
    }

    const notOnWhatsappNext = values.notOnWhatsapp === true;
    if (notOnWhatsappNext !== (initialValues.notOnWhatsapp ?? false)) {
      payload.notOnWhatsapp = notOnWhatsappNext;
    }

    const addressTrim = (values.address ?? '').trim();
    const initAddress = initialValues.address ?? '';
    if (addressTrim !== initAddress) {
      payload.address = addressTrim === '' ? null : addressTrim;
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
                  placeholder="Pune, Maharashtra"
                  autoComplete="off"
                  disabled={formDisabled}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Backwards-data fallback: only render the City editor when
              the lead already has a `city` value but no `address`. New
              edits should go into Address instead. */}
          {(initialValues.city ?? '').trim() !== '' &&
          (initialValues.address ?? '').trim() === '' ? (
            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    City{' '}
                    <span className="text-muted-foreground">
                      (legacy — superseded by Address)
                    </span>
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
          ) : null}

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

        {/* ----------------------------------------------------------
             v0.1.4 — Profile (optional) section.
             Same field set as the create form so the read/write
             surfaces stay aligned to the Chitly team's spreadsheet.
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
              name="activeSince"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Active Since</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="10 Days, 6 months, etc."
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
                    disabled={formDisabled}
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
                    disabled={formDisabled}
                    placeholder="Press Enter to add (e.g. Hindi, English)"
                    maxTags={20}
                  />
                </FormControl>
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
            name="notOnWhatsapp"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox
                    id="lead-edit-not-whatsapp"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={formDisabled}
                  />
                </FormControl>
                <FormLabel
                  htmlFor="lead-edit-not-whatsapp"
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
                  disabled={formDisabled}
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
                  (when the lead came in — backdate if needed)
                </span>
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
