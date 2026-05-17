'use client';

/**
 * CampaignEditForm — `react-hook-form` + zod form for
 * `PATCH /api/campaigns/[id]` (SPEC §7.2.1, §7.2.2).
 *
 * Mirrors the API's `campaignUpdateSchema` so client and server
 * validate the same shape. The form is "diff-based": on submit we
 * send only the fields that actually changed against
 * `initialValues`. This:
 *
 *   • Keeps activity log noise low — a no-op submit doesn't fire a
 *     `campaign.updated` row.
 *   • Lets the API's spend / metrics / generic-update log paths fire
 *     correctly (the route inspects which fields changed).
 *
 * Authorisation:
 *   • The API enforces "ADMIN or owner" for any PATCH (SPEC §2.1, §7);
 *     the parent page passes `canEdit` so we render read-only inputs
 *     when the current user can't write.
 *   • Only ADMIN may reassign to another user.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { CampaignChannel, CampaignStatus } from '@prisma/client';
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
import { isValidUtmValue } from '@/lib/utm';

import type { OwnerOption } from '../new/campaign-create-form';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Generic non-negative integer string field (impressions/clicks/…). */
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
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(200, 'Name must be 200 characters or fewer'),
    channel: z.nativeEnum(CampaignChannel),
    status: z.nativeEnum(CampaignStatus),
    startDate: z
      .string()
      .min(1, 'Start date is required')
      .refine(
        (val) => !Number.isNaN(new Date(val).getTime()),
        'Invalid start date',
      ),
    endDate: z
      .string()
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => !val || !Number.isNaN(new Date(val).getTime()),
        'Invalid end date',
      ),
    budget: z
      .string()
      .trim()
      .min(1, 'Budget is required')
      .refine(
        (val) => {
          const n = Number(val);
          return Number.isFinite(n) && n > 0;
        },
        'Budget must be greater than zero',
      ),
    spent: z
      .string()
      .trim()
      .min(1, 'Spent is required')
      .refine(
        (val) => {
          const n = Number(val);
          return Number.isFinite(n) && n >= 0;
        },
        'Spent must be non-negative',
      ),
    impressions: counterField,
    clicks: counterField,
    signups: counterField,
    conversions: counterField,
    utmSource: z
      .string()
      .trim()
      .max(200, 'UTM source must be 200 characters or fewer')
      .optional()
      .or(z.literal('')),
    utmMedium: z
      .string()
      .trim()
      .max(200, 'UTM medium must be 200 characters or fewer')
      .optional()
      .or(z.literal('')),
    utmCampaign: z
      .string()
      .trim()
      .max(200, 'UTM campaign must be 200 characters or fewer')
      .optional()
      .or(z.literal('')),
    notes: z
      .string()
      .max(5000, 'Notes must be 5000 characters or fewer')
      .optional()
      .or(z.literal('')),
    ownerId: z.string().min(1, 'Owner is required'),
  })
  .refine(
    (val) =>
      !val.endDate ||
      new Date(val.endDate).getTime() >= new Date(val.startDate).getTime(),
    {
      message: 'End date must be on or after start date',
      path: ['endDate'],
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
  if (status === 403) return 'You are not allowed to edit this campaign.';
  if (status === 404) return 'Campaign not found.';
  if (status === 409) {
    return 'A campaign with this UTM tag already exists. Pick a different one.';
  }
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

const CHANNEL_LABELS: Record<CampaignChannel, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  INSTAGRAM_ORGANIC: 'Instagram Organic',
  YOUTUBE: 'YouTube',
  INFLUENCER: 'Influencer',
  EMAIL: 'Email',
  OTHER: 'Other',
};

const STATUS_LABELS: Record<CampaignStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  ENDED: 'Ended',
};

const CHANNEL_VALUES = Object.keys(CHANNEL_LABELS) as CampaignChannel[];
const STATUS_VALUES = Object.keys(STATUS_LABELS) as CampaignStatus[];

/** Convert a YYYY-MM-DD date input into a UTC ISO string at midnight. */
function dateInputToIso(value: string): string {
  return new Date(`${value}T00:00:00Z`).toISOString();
}

/**
 * Convert a Date to a YYYY-MM-DD string in UTC. Campaign dates are
 * stored as `DateTime` but represent calendar days — we render the
 * UTC date so the round-trip is stable regardless of viewer time
 * zone.
 */
function dateToIsoDate(date: Date | string | null): string {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface CampaignEditFormProps {
  campaignId: string;
  isAdmin: boolean;
  /** When false, every field renders disabled — read-only fallback. */
  canEdit: boolean;
  currentUserId: string;
  ownerOptions: OwnerOption[];
  initialValues: {
    name: string;
    channel: CampaignChannel;
    status: CampaignStatus;
    startDate: Date | string;
    endDate: Date | string | null;
    budget: number;
    spent: number;
    impressions: number;
    clicks: number;
    signups: number;
    conversions: number;
    utmSource: string | null;
    utmMedium: string | null;
    utmCampaign: string | null;
    notes: string | null;
    ownerId: string;
  };
}

export function CampaignEditForm({
  campaignId,
  isAdmin,
  canEdit,
  currentUserId,
  ownerOptions,
  initialValues,
}: CampaignEditFormProps) {
  const router = useRouter();

  const startDateInput = dateToIsoDate(initialValues.startDate);
  const endDateInput = dateToIsoDate(initialValues.endDate);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: initialValues.name,
      channel: initialValues.channel,
      status: initialValues.status,
      startDate: startDateInput,
      endDate: endDateInput,
      budget: String(initialValues.budget),
      spent: String(initialValues.spent),
      impressions: String(initialValues.impressions),
      clicks: String(initialValues.clicks),
      signups: String(initialValues.signups),
      conversions: String(initialValues.conversions),
      utmSource: initialValues.utmSource ?? '',
      utmMedium: initialValues.utmMedium ?? '',
      utmCampaign: initialValues.utmCampaign ?? '',
      notes: initialValues.notes ?? '',
      ownerId: initialValues.ownerId,
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const formDisabled = !canEdit || isSubmitting;

  // Encoding-warning watchers for UTM fields.
  const utmSource = form.watch('utmSource') ?? '';
  const utmMedium = form.watch('utmMedium') ?? '';
  const utmCampaign = form.watch('utmCampaign') ?? '';
  const utmSourceWarning =
    utmSource.trim() !== '' && !isValidUtmValue(utmSource.trim());
  const utmMediumWarning =
    utmMedium.trim() !== '' && !isValidUtmValue(utmMedium.trim());
  const utmCampaignWarning =
    utmCampaign.trim() !== '' && !isValidUtmValue(utmCampaign.trim());

  async function onSubmit(values: FormValues) {
    // Diff against `initialValues`. Empty UTM strings → null so the
    // column is cleared rather than set to ''.
    const payload: Record<string, unknown> = {};

    const nameTrim = values.name.trim();
    if (nameTrim !== initialValues.name) payload.name = nameTrim;

    if (values.channel !== initialValues.channel) {
      payload.channel = values.channel;
    }
    if (values.status !== initialValues.status) {
      payload.status = values.status;
    }

    const startIso = dateInputToIso(values.startDate);
    const initStartIso = new Date(initialValues.startDate).toISOString();
    if (startIso !== initStartIso) payload.startDate = startIso;

    const endIsoNext =
      values.endDate && values.endDate.trim() !== ''
        ? dateInputToIso(values.endDate)
        : null;
    const initEndIso = initialValues.endDate
      ? new Date(initialValues.endDate).toISOString()
      : null;
    if (endIsoNext !== initEndIso) {
      payload.endDate = endIsoNext;
    }

    const budgetNext = Number(values.budget);
    if (budgetNext !== initialValues.budget) payload.budget = budgetNext;

    const spentNext = Number(values.spent);
    if (spentNext !== initialValues.spent) payload.spent = spentNext;

    const impressionsNext = Number(values.impressions);
    if (impressionsNext !== initialValues.impressions) {
      payload.impressions = impressionsNext;
    }
    const clicksNext = Number(values.clicks);
    if (clicksNext !== initialValues.clicks) payload.clicks = clicksNext;
    const signupsNext = Number(values.signups);
    if (signupsNext !== initialValues.signups) payload.signups = signupsNext;
    const conversionsNext = Number(values.conversions);
    if (conversionsNext !== initialValues.conversions) {
      payload.conversions = conversionsNext;
    }

    const utmSourceNext = (values.utmSource ?? '').trim();
    const initUtmSource = initialValues.utmSource ?? '';
    if (utmSourceNext !== initUtmSource) {
      payload.utmSource = utmSourceNext === '' ? null : utmSourceNext;
    }

    const utmMediumNext = (values.utmMedium ?? '').trim();
    const initUtmMedium = initialValues.utmMedium ?? '';
    if (utmMediumNext !== initUtmMedium) {
      payload.utmMedium = utmMediumNext === '' ? null : utmMediumNext;
    }

    const utmCampaignNext = (values.utmCampaign ?? '').trim();
    const initUtmCampaign = initialValues.utmCampaign ?? '';
    if (utmCampaignNext !== initUtmCampaign) {
      payload.utmCampaign = utmCampaignNext === '' ? null : utmCampaignNext;
    }

    const notesNext = (values.notes ?? '').trim();
    const initNotes = initialValues.notes ?? '';
    if (notesNext !== initNotes) {
      payload.notes = notesNext === '' ? null : notesNext;
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
      res = await fetch(`/api/campaigns/${campaignId}`, {
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

    toast.success('Campaign updated.');
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
                <FormLabel>Campaign name</FormLabel>
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
            name="channel"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Channel</FormLabel>
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
                    {CHANNEL_VALUES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {CHANNEL_LABELS[v]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
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
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start date</FormLabel>
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
            name="endDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  End date{' '}
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
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="budget"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Budget (₹)</FormLabel>
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

          <FormField
            control={form.control}
            name="spent"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Spent (₹)</FormLabel>
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

        <div className="grid gap-4 sm:grid-cols-4">
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

          <FormField
            control={form.control}
            name="clicks"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Clicks</FormLabel>
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
            name="signups"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Signups</FormLabel>
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
            name="conversions"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Conversions</FormLabel>
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

        <div className="space-y-3 rounded-md border bg-muted/20 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-foreground">
              UTM tags{' '}
              <span className="text-muted-foreground">(optional)</span>
            </h3>
            <p className="text-xs text-muted-foreground">
              Leads with a matching <code>utm_campaign</code> appear
              under the linked-leads tab.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="utmSource"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>utm_source</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  {utmSourceWarning ? (
                    <p className="text-xs text-status-amber">
                      Contains characters that will be percent-encoded
                      in the URL.
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmMedium"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>utm_medium</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  {utmMediumWarning ? (
                    <p className="text-xs text-status-amber">
                      Contains characters that will be percent-encoded
                      in the URL.
                    </p>
                  ) : null}
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="utmCampaign"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>utm_campaign</FormLabel>
                  <FormControl>
                    <Input
                      autoComplete="off"
                      disabled={formDisabled}
                      {...field}
                    />
                  </FormControl>
                  {utmCampaignWarning ? (
                    <p className="text-xs text-status-amber">
                      Contains characters that will be percent-encoded
                      in the URL.
                    </p>
                  ) : null}
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
                  Only admins can reassign campaigns.
                </FormDescription>
              ) : null}
              <FormMessage />
            </FormItem>
          )}
        />

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
