'use client';

/**
 * CampaignCreateForm — `react-hook-form` + zod form for
 * `POST /api/campaigns` (SPEC §7.1, §7.2.1).
 *
 * Mirrors the API's `campaignCreateSchema` so client and server
 * validate the same shape. On submit:
 *
 *   1. POSTs JSON to `/api/campaigns`.
 *   2. On success → redirect to `/marketing/[id]` (the new row).
 *   3. On 4xx/5xx → toast the error and stay on the form.
 *
 * Field-level notes:
 *   • `name` is required.
 *   • `channel` is one of the seven `CampaignChannel` enum values.
 *   • `status` defaults to DRAFT.
 *   • `startDate` is required; `endDate` is optional but must be on
 *     or after `startDate` when present.
 *   • `budget` is required, in INR, > 0.
 *   • `spent` defaults to 0; non-negative.
 *   • `utmCampaign` is auto-suggested from the campaign name via
 *     `slugifyCampaign` — the user can override it. Validation
 *     warns when a UTM value would need percent-encoding.
 *   • `notes` is optional, max 5 000 chars.
 *   • `ownerId` defaults to the current user; admins can pick any
 *     active user.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Wand2 } from 'lucide-react';
import {
  CampaignChannel,
  CampaignStatus,
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
import { isValidUtmValue, slugifyCampaign } from '@/lib/utm';

// ---------------------------------------------------------------------------
// Schema (client-side mirror of `campaignCreateSchema`)
// ---------------------------------------------------------------------------

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
      .optional()
      .or(z.literal(''))
      .refine(
        (val) => {
          if (!val) return true;
          const n = Number(val);
          return Number.isFinite(n) && n >= 0;
        },
        'Spent must be a non-negative number',
      ),
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

interface CreatedCampaign {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to create campaigns here.';
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

/**
 * Convert a YYYY-MM-DD date input into a UTC ISO string at the start
 * of the day. The API's `campaignCreateSchema` uses `z.coerce.date()`,
 * so an ISO string round-trips cleanly.
 */
function dateInputToIso(value: string): string {
  // Browsers parse `YYYY-MM-DD` as UTC midnight, which is what we
  // want — campaigns track calendar dates, not specific instants.
  return new Date(`${value}T00:00:00Z`).toISOString();
}

/** Today as YYYY-MM-DD in the user's local time zone. */
function todayLocalIso(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ---------------------------------------------------------------------------
// Public types + component
// ---------------------------------------------------------------------------

export interface OwnerOption {
  id: string;
  label: string;
}

export interface CampaignCreateFormProps {
  currentUserId: string;
  currentUserRole: Role;
  ownerOptions: OwnerOption[];
}

export function CampaignCreateForm({
  currentUserId,
  ownerOptions,
}: CampaignCreateFormProps) {
  const router = useRouter();

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      channel: CampaignChannel.META_ADS,
      status: CampaignStatus.DRAFT,
      startDate: todayLocalIso(),
      endDate: '',
      budget: '',
      spent: '0',
      utmSource: '',
      utmMedium: '',
      utmCampaign: '',
      notes: '',
      ownerId: currentUserId,
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  // Watch every UTM field so we can render an inline encoding warning
  // when the user types a value that would need percent-encoding —
  // SPEC §7.2.5 surfaces the same warning in the UTM builder.
  const utmSource = form.watch('utmSource') ?? '';
  const utmMedium = form.watch('utmMedium') ?? '';
  const utmCampaign = form.watch('utmCampaign') ?? '';

  const utmSourceWarning =
    utmSource.trim() !== '' && !isValidUtmValue(utmSource.trim());
  const utmMediumWarning =
    utmMedium.trim() !== '' && !isValidUtmValue(utmMedium.trim());
  const utmCampaignWarning =
    utmCampaign.trim() !== '' && !isValidUtmValue(utmCampaign.trim());

  /**
   * "Suggest" button next to the UTM campaign field — fills it with a
   * URL-safe slug of the campaign name. Mirrors SPEC §7.2.1
   * "UTM params auto-suggested from name".
   */
  const suggestUtmCampaign = () => {
    const slug = slugifyCampaign(form.getValues('name'));
    if (slug) {
      form.setValue('utmCampaign', slug, { shouldValidate: true });
    }
  };

  async function onSubmit(values: FormValues) {
    // Build the API payload — strip empty optional strings, coerce
    // dates and money strings to the API's expected types.
    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      channel: values.channel,
      status: values.status,
      startDate: dateInputToIso(values.startDate),
      budget: Number(values.budget),
      ownerId: values.ownerId,
    };

    if (values.endDate && values.endDate.trim() !== '') {
      payload.endDate = dateInputToIso(values.endDate);
    }

    const spentRaw = (values.spent ?? '').trim();
    if (spentRaw !== '') {
      payload.spent = Number(spentRaw);
    }

    const utmSourceTrim = (values.utmSource ?? '').trim();
    if (utmSourceTrim !== '') payload.utmSource = utmSourceTrim;

    const utmMediumTrim = (values.utmMedium ?? '').trim();
    if (utmMediumTrim !== '') payload.utmMedium = utmMediumTrim;

    const utmCampaignTrim = (values.utmCampaign ?? '').trim();
    if (utmCampaignTrim !== '') payload.utmCampaign = utmCampaignTrim;

    const notesTrim = (values.notes ?? '').trim();
    if (notesTrim !== '') payload.notes = notesTrim;

    let res: Response;
    try {
      res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch {
      toast.error('Network error. Please try again.');
      return;
    }

    let body: ApiErrorBody | CreatedCampaign | null = null;
    try {
      body = (await res.json()) as ApiErrorBody | CreatedCampaign;
    } catch {
      body = null;
    }

    if (!res.ok) {
      toast.error(describeError(body as ApiErrorBody | null, res.status));
      return;
    }

    const created = body as CreatedCampaign | null;
    if (!created?.id) {
      toast.error('Unexpected response from the server.');
      return;
    }

    toast.success('Campaign created.');
    router.replace(`/marketing/${created.id}`);
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
                    placeholder="Meta Reels July"
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
            name="channel"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Channel</FormLabel>
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
            name="startDate"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Start date</FormLabel>
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
                    placeholder="50000"
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
            name="spent"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Already spent (₹){' '}
                  <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="0"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormDescription>
                  Defaults to 0. You can update this later from the
                  campaign detail page.
                </FormDescription>
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
              Used to attribute leads back to this campaign. Leads with
              a matching <code>utm_campaign</code> will appear under
              the campaign detail page automatically.
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
                      placeholder="meta"
                      autoComplete="off"
                      disabled={isSubmitting}
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
                      placeholder="cpc"
                      autoComplete="off"
                      disabled={isSubmitting}
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
                    <div className="flex gap-2">
                      <Input
                        placeholder="meta_reels_july"
                        autoComplete="off"
                        disabled={isSubmitting}
                        {...field}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={suggestUtmCampaign}
                        disabled={
                          isSubmitting ||
                          form.getValues('name').trim() === ''
                        }
                        title="Generate from campaign name"
                      >
                        <Wand2 className="h-4 w-4" aria-hidden="true" />
                        <span className="sr-only">
                          Generate slug from name
                        </span>
                      </Button>
                    </div>
                  </FormControl>
                  <FormDescription>
                    Must be unique. Click the wand to fill from the
                    campaign name.
                  </FormDescription>
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
                  placeholder="Brief, target audience, creative notes…"
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
            onClick={() => router.push('/marketing')}
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
              'Create campaign'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
