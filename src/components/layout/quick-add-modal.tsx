'use client';

/**
 * QuickAddModal — cross-page quick-add dialog (SPEC.md §9.2.5,
 * "Quick add from any page (modal): assign to me / select assignee").
 *
 * Triggered by the topbar's "Quick add" button. Renders a tabbed
 * dialog with one minimal form per entity:
 *
 *   • Lead          → POST /api/leads
 *   • Campaign      → POST /api/campaigns
 *   • Social post   → POST /api/social/posts
 *   • Dev task      → POST /api/dev/tasks
 *
 * Each form posts only the bare-minimum fields required by the API
 * schema; the user can flesh out the rest on the dedicated detail
 * page after the row is created. On success we toast + redirect to
 * the newly-created row's detail surface (or the relevant list when
 * a detail page isn't part of v1, e.g. dev tasks).
 *
 * Why a single dialog with tabs (vs. four separate quick-add modals)?
 * SPEC.md §9.2.5 calls out a single "quick add from any page" affordance.
 * Tabs keep the entity choice visible and let users switch without
 * re-opening the modal.
 *
 * Why not pre-populate any fields beyond "assign to me" / "owner =
 * me"? The brief says minimal — the dedicated `/leads/new`,
 * `/marketing/new`, `/social/new`, `/dev/new` flows are still the
 * full-fat surfaces. Quick add is for capture speed, not data
 * completeness.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import {
  CampaignChannel,
  DevTaskType,
  LeadSource,
  PostStatus,
  Priority,
  SocialPlatform,
} from '@prisma/client';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CreatedEntity {
  id: string;
}

interface ApiErrorBody {
  error?: string;
  message?: string;
  issues?: Array<{ message?: string; path?: (string | number)[] }>;
}

function describeError(body: ApiErrorBody | null, status: number): string {
  if (status === 401) return 'Your session has expired. Please sign in again.';
  if (status === 403) return 'You are not allowed to do that.';
  if (body?.issues && body.issues.length > 0) {
    return body.issues[0]?.message ?? 'Some fields are invalid.';
  }
  if (body?.message) return body.message;
  if (body?.error) return body.error;
  return 'Something went wrong. Please try again.';
}

async function postJson(
  url: string,
  payload: unknown,
): Promise<
  | { ok: true; data: CreatedEntity }
  | { ok: false; message: string }
> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    return { ok: false, message: 'Network error. Please try again.' };
  }

  let body: ApiErrorBody | CreatedEntity | null = null;
  try {
    body = (await res.json()) as ApiErrorBody | CreatedEntity;
  } catch {
    body = null;
  }

  if (!res.ok) {
    return {
      ok: false,
      message: describeError(body as ApiErrorBody | null, res.status),
    };
  }
  const created = body as CreatedEntity | null;
  if (!created?.id) {
    return { ok: false, message: 'Unexpected response from the server.' };
  }
  return { ok: true, data: created };
}

// ---------------------------------------------------------------------------
// Tabs configuration
// ---------------------------------------------------------------------------

type EntityTab = 'lead' | 'campaign' | 'social' | 'dev';

const TAB_LABELS: Record<EntityTab, string> = {
  lead: 'Lead',
  campaign: 'Campaign',
  social: 'Social',
  dev: 'Task',
};

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

export interface QuickAddModalProps {
  /** Current user id — used to auto-assign new tasks to "me". */
  currentUserId: string;
  /** Render-prop slot for the trigger; defaults to a small "Quick add"
   *  button styled to fit inside the Topbar. */
  trigger?: React.ReactNode;
}

export function QuickAddModal({
  currentUserId,
  trigger,
}: QuickAddModalProps) {
  const [open, setOpen] = React.useState(false);
  const [tab, setTab] = React.useState<EntityTab>('lead');

  // Reset to the leads tab whenever the dialog re-opens — avoids the
  // confusing "I opened quick add for the first time today and it's
  // showing me a campaign form" situation.
  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) setTab('lead');
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            // Always visible — icon-only on mobile (< sm) so the
            // affordance still exists on a 375 px viewport
            // (SPEC §13.2 mobile QA pass).
            className="inline-flex"
            aria-label="Quick add"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            <span className="hidden sm:inline">Quick add</span>
          </Button>
        )}
      </DialogTrigger>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Quick add</DialogTitle>
          <DialogDescription>
            Capture a record in seconds. Open the full form to set
            everything else.
          </DialogDescription>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as EntityTab)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-4">
            {(['lead', 'campaign', 'social', 'dev'] as const).map((id) => (
              <TabsTrigger key={id} value={id}>
                {TAB_LABELS[id]}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="lead" className="mt-4">
            <QuickAddLead onSuccess={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="campaign" className="mt-4">
            <QuickAddCampaign onSuccess={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="social" className="mt-4">
            <QuickAddSocial onSuccess={() => setOpen(false)} />
          </TabsContent>
          <TabsContent value="dev" className="mt-4">
            <QuickAddDev
              currentUserId={currentUserId}
              onSuccess={() => setOpen(false)}
            />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-form: Lead
// ---------------------------------------------------------------------------

const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

const leadFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Name is required')
      .max(200, 'Name must be 200 characters or fewer'),
    phone: z
      .string()
      .trim()
      .max(32)
      .refine(
        (v) => v === '' || phoneRegex.test(v),
        'Invalid phone number',
      )
      .refine(
        (v) => v === '' || (v.match(/\d/g)?.length ?? 0) >= 7,
        'Phone must contain at least 7 digits',
      ),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .max(254)
      .refine(
        (v) => v === '' || /^\S+@\S+\.\S+$/.test(v),
        'Invalid email address',
      ),
    source: z.nativeEnum(LeadSource),
  })
  .refine((v) => v.phone.trim() !== '' || v.email.trim() !== '', {
    message: 'Either phone or email is required',
    path: ['phone'],
  });

function QuickAddLead({ onSuccess }: { onSuccess: () => void }) {
  const router = useRouter();
  const form = useForm<z.infer<typeof leadFormSchema>>({
    resolver: zodResolver(leadFormSchema),
    defaultValues: {
      name: '',
      phone: '',
      email: '',
      source: LeadSource.MANUAL,
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: z.infer<typeof leadFormSchema>) {
    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      source: values.source,
    };
    const phone = values.phone.trim();
    if (phone !== '') payload.phone = phone;
    const email = values.email.trim();
    if (email !== '') payload.email = email;

    const result = await postJson('/api/leads', payload);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Lead created.');
    onSuccess();
    router.push(`/leads/${result.data.id}`);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
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

        <div className="grid gap-3 sm:grid-cols-2">
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
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

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
                  {(Object.keys(LeadSource) as LeadSource[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {prettyEnum(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitFooter
          isSubmitting={isSubmitting}
          submitLabel="Create lead"
        />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Sub-form: Campaign
// ---------------------------------------------------------------------------

const campaignFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(200, 'Name must be 200 characters or fewer'),
  channel: z.nativeEnum(CampaignChannel),
  startDate: z.string().min(1, 'Start date is required'),
  budget: z
    .string()
    .min(1, 'Budget is required')
    .refine(
      (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0;
      },
      'Budget must be a positive number',
    ),
});

function QuickAddCampaign({ onSuccess }: { onSuccess: () => void }) {
  const router = useRouter();
  const form = useForm<z.infer<typeof campaignFormSchema>>({
    resolver: zodResolver(campaignFormSchema),
    defaultValues: {
      name: '',
      channel: CampaignChannel.META_ADS,
      startDate: new Date().toISOString().slice(0, 10),
      budget: '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: z.infer<typeof campaignFormSchema>) {
    const payload: Record<string, unknown> = {
      name: values.name.trim(),
      channel: values.channel,
      startDate: new Date(`${values.startDate}T00:00:00`).toISOString(),
      budget: Number(values.budget),
    };

    const result = await postJson('/api/campaigns', payload);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Campaign created.');
    onSuccess();
    router.push(`/marketing/${result.data.id}`);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Campaign name</FormLabel>
              <FormControl>
                <Input
                  placeholder="Diwali Sale 2026"
                  autoComplete="off"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-3 sm:grid-cols-2">
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
                    {(Object.keys(CampaignChannel) as CampaignChannel[]).map(
                      (c) => (
                        <SelectItem key={c} value={c}>
                          {prettyEnum(c)}
                        </SelectItem>
                      ),
                    )}
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
        </div>

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
                  min={1}
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

        <SubmitFooter
          isSubmitting={isSubmitting}
          submitLabel="Create campaign"
        />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Sub-form: Social post
// ---------------------------------------------------------------------------

const socialFormSchema = z.object({
  platform: z.nativeEnum(SocialPlatform),
  caption: z
    .string()
    .trim()
    .min(1, 'Caption is required')
    .max(5000, 'Caption must be 5000 characters or fewer'),
});

function QuickAddSocial({ onSuccess }: { onSuccess: () => void }) {
  const router = useRouter();
  const form = useForm<z.infer<typeof socialFormSchema>>({
    resolver: zodResolver(socialFormSchema),
    defaultValues: {
      platform: SocialPlatform.INSTAGRAM,
      caption: '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: z.infer<typeof socialFormSchema>) {
    const payload: Record<string, unknown> = {
      platform: values.platform,
      status: PostStatus.DRAFT,
      caption: values.caption.trim(),
    };

    const result = await postJson('/api/social/posts', payload);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Draft created.');
    onSuccess();
    router.push(`/social/${result.data.id}`);
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
        noValidate
      >
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
                  {(Object.keys(SocialPlatform) as SocialPlatform[]).map(
                    (p) => (
                      <SelectItem key={p} value={p}>
                        {prettyEnum(p)}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="caption"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Caption</FormLabel>
              <FormControl>
                <Textarea
                  rows={5}
                  maxLength={5000}
                  placeholder="What's the post about?"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <SubmitFooter
          isSubmitting={isSubmitting}
          submitLabel="Save draft"
        />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Sub-form: Dev task
// ---------------------------------------------------------------------------

const devFormSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1, 'Title is required')
    .max(200, 'Title must be 200 characters or fewer'),
  type: z.nativeEnum(DevTaskType),
  priority: z.nativeEnum(Priority),
  /** "" = unassigned, otherwise a user id. */
  assigneeId: z.string(),
});

function QuickAddDev({
  currentUserId,
  onSuccess,
}: {
  currentUserId: string;
  onSuccess: () => void;
}) {
  const router = useRouter();
  const form = useForm<z.infer<typeof devFormSchema>>({
    resolver: zodResolver(devFormSchema),
    defaultValues: {
      title: '',
      type: DevTaskType.FEATURE,
      priority: Priority.MEDIUM,
      // SPEC.md §9.2.5 — "Assign to me default".
      assigneeId: currentUserId,
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: z.infer<typeof devFormSchema>) {
    // RELEASE quick-add isn't supported here — release entries need
    // version + platform which don't fit in a quick-capture form.
    if (values.type === DevTaskType.RELEASE) {
      toast.error(
        'Use the full form (Dev → Log release) to capture releases.',
      );
      return;
    }

    const payload: Record<string, unknown> = {
      title: values.title.trim(),
      type: values.type,
      priority: values.priority,
    };
    if (values.assigneeId && values.assigneeId.trim() !== '') {
      payload.assigneeId = values.assigneeId;
    }

    const result = await postJson('/api/dev/tasks', payload);
    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success('Task created.');
    onSuccess();
    // No /dev/[id] detail page in v1 — land on the kanban so the
    // user sees their fresh card.
    router.push('/dev');
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-4"
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
                  placeholder="Short summary"
                  autoComplete="off"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-3 sm:grid-cols-2">
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
                    <SelectItem value={DevTaskType.FEATURE}>Feature</SelectItem>
                    <SelectItem value={DevTaskType.BUG}>Bug</SelectItem>
                    <SelectItem value={DevTaskType.CHORE}>Chore</SelectItem>
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
                    {(Object.keys(Priority) as Priority[]).map((p) => (
                      <SelectItem key={p} value={p}>
                        {prettyEnum(p)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <p className="text-xs text-muted-foreground">
          Assigned to you by default. Switch the assignee on the full
          form after creating.
        </p>

        <SubmitFooter
          isSubmitting={isSubmitting}
          submitLabel="Create task"
        />
      </form>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Shared: submit footer
// ---------------------------------------------------------------------------

function SubmitFooter({
  isSubmitting,
  submitLabel,
}: {
  isSubmitting: boolean;
  submitLabel: string;
}) {
  return (
    <div className={cn('flex items-center justify-end gap-2 pt-2')}>
      <Button type="submit" disabled={isSubmitting}>
        {isSubmitting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            <span>Creating…</span>
          </>
        ) : (
          submitLabel
        )}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers (display-only)
// ---------------------------------------------------------------------------

/** Convert UPPER_SNAKE_CASE → "Upper snake case" for select labels. */
function prettyEnum(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((w, i) =>
      i === 0 && w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w,
    )
    .join(' ');
}
