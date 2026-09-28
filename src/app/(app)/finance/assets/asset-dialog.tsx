'use client';

/**
 * Add / edit an asset. On create it can also be handed to someone straight
 * away; after that, moves go through the hand-over dialog so the trail of
 * who had it when is kept.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import { AssetKind, AssetStatus } from '@prisma/client';
import { toast } from 'sonner';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
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
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  ASSET_CATEGORY_SUGGESTIONS,
  ASSET_KIND_LABELS,
  ASSET_STATUS_LABELS,
} from '@/lib/assets';
import { formatInr } from '@/lib/finance';

import { NONE_VALUE, requestJson, todayLocalDateKey } from '../finance-ui';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMPANY = 'company';

export interface AssetPeopleOption {
  users: { id: string; name: string }[];
  parties: { id: string; name: string }[];
}

export interface AssetPaymentOption {
  id: string;
  date: string;
  amount: number;
  label: string;
}

export interface AssetDialogAsset {
  id: string;
  name: string;
  kind: AssetKind;
  category: string | null;
  identifier: string | null;
  purchaseDate: string;
  cost: number | null;
  transactionId: string | null;
  status: AssetStatus;
  renewsOn: string;
  notes: string | null;
}

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  kind: z.nativeEnum(AssetKind),
  category: z.string().trim().max(60),
  identifier: z.string().trim().max(120),
  purchaseDate: z.string().refine((v) => v === '' || DATE_RE.test(v), 'Pick a date'),
  cost: z
    .string()
    .trim()
    .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) > 0), 'Cost must be above zero'),
  transactionId: z.string(),
  status: z.nativeEnum(AssetStatus),
  renewsOn: z.string().refine((v) => v === '' || DATE_RE.test(v), 'Pick a date'),
  notes: z.string().trim().max(2000),
  holder: z.string(),
  location: z.string().trim().max(120),
});

type FormValues = z.infer<typeof formSchema>;

export interface AssetDialogProps {
  mode: 'create' | 'edit';
  asset?: AssetDialogAsset;
  people: AssetPeopleOption;
  /** Unlinked payments to pick from (plus the asset's own, when editing). */
  payments: AssetPaymentOption[];
  /** Prefill from a transaction ("Record as asset" on a ledger row). */
  preset?: Partial<Pick<AssetDialogAsset, 'name' | 'purchaseDate' | 'cost' | 'transactionId'>>;
  /** Open on mount (used with `preset`). */
  defaultOpen?: boolean;
  trigger?: React.ReactNode;
}

function initialValues(asset?: AssetDialogAsset, preset?: AssetDialogProps['preset']): FormValues {
  return {
    name: asset?.name ?? preset?.name ?? '',
    kind: asset?.kind ?? AssetKind.PHYSICAL,
    category: asset?.category ?? '',
    identifier: asset?.identifier ?? '',
    purchaseDate: asset?.purchaseDate ?? preset?.purchaseDate ?? todayLocalDateKey(),
    cost: asset?.cost != null ? String(asset.cost) : preset?.cost != null ? String(preset.cost) : '',
    transactionId: asset?.transactionId ?? preset?.transactionId ?? NONE_VALUE,
    status: asset?.status ?? AssetStatus.IN_STOCK,
    renewsOn: asset?.renewsOn ?? '',
    notes: asset?.notes ?? '',
    holder: COMPANY,
    location: '',
  };
}

export function AssetDialog({
  mode,
  asset,
  people,
  payments,
  preset,
  defaultOpen = false,
  trigger,
}: AssetDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(defaultOpen);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: initialValues(asset, preset),
  });
  const isSubmitting = form.formState.isSubmitting;
  const kind = form.watch('kind');

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) form.reset(initialValues(asset, preset));
  };

  // Picking the payment fills in what it already knows.
  const onPickPayment = (id: string) => {
    form.setValue('transactionId', id);
    const p = payments.find((x) => x.id === id);
    if (!p) return;
    if (form.getValues('cost') === '') form.setValue('cost', String(p.amount));
    form.setValue('purchaseDate', p.date);
  };

  async function onSubmit(values: FormValues) {
    const cost = values.cost === '' ? null : Number(values.cost);
    const transactionId = values.transactionId === NONE_VALUE ? null : values.transactionId;
    const [holderKind, holderId] = values.holder.split(':');

    const payload: Record<string, unknown> =
      mode === 'create'
        ? {
            name: values.name,
            kind: values.kind,
            ...(values.category ? { category: values.category } : {}),
            ...(values.identifier ? { identifier: values.identifier } : {}),
            ...(values.purchaseDate ? { purchaseDate: values.purchaseDate } : {}),
            ...(cost !== null ? { cost } : {}),
            ...(transactionId ? { transactionId } : {}),
            ...(values.renewsOn ? { renewsOn: values.renewsOn } : {}),
            ...(values.notes ? { notes: values.notes } : {}),
            ...(holderKind !== COMPANY || values.location
              ? {
                  holder: {
                    ...(holderKind === 'user' ? { toUserId: holderId } : {}),
                    ...(holderKind === 'party' ? { toPartyId: holderId } : {}),
                    ...(values.location ? { location: values.location } : {}),
                  },
                }
              : {}),
          }
        : {
            name: values.name,
            kind: values.kind,
            category: values.category || null,
            identifier: values.identifier || null,
            purchaseDate: values.purchaseDate || null,
            cost,
            transactionId,
            status: values.status,
            renewsOn: values.renewsOn || null,
            notes: values.notes || null,
          };

    const result =
      mode === 'create'
        ? await requestJson<{ id: string }>('/api/finance/assets', { method: 'POST', json: payload })
        : await requestJson<{ id: string }>(`/api/finance/assets/${asset?.id}`, {
            method: 'PATCH',
            json: payload,
          });

    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(mode === 'create' ? 'Asset added.' : 'Asset updated.');
    setOpen(false);
    if (mode === 'create') router.push(`/finance/assets/${result.data.id}`);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" size="sm" variant={mode === 'create' ? 'default' : 'outline'}>
            {mode === 'create' ? (
              <>
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Add asset</span>
              </>
            ) : (
              'Edit'
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Add asset' : 'Edit asset'}</DialogTitle>
          <DialogDescription>
            Something we bought and still own. Link the payment so the money is not counted twice.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="asset-form"
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
                    <Input placeholder="Jio SIM — Anchal" autoComplete="off" disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Kind</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.values(AssetKind).map((k) => (
                          <SelectItem key={k} value={k}>
                            {ASSET_KIND_LABELS[k]}
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
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Category <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        list="asset-categories"
                        placeholder="Laptop, Phone, SIM, Domain…"
                        autoComplete="off"
                        disabled={isSubmitting}
                        {...field}
                      />
                    </FormControl>
                    <datalist id="asset-categories">
                      {ASSET_CATEGORY_SUGGESTIONS.map((c) => (
                        <option key={c} value={c} />
                      ))}
                    </datalist>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="identifier"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Serial / IMEI / number <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="86687 70573" autoComplete="off" disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormDescription>Tells two look-alike items apart.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="transactionId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Paid by <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <Select value={field.value} onValueChange={onPickPayment} disabled={isSubmitting}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent className="max-h-72">
                      <SelectItem value={NONE_VALUE}>Not linked to a payment</SelectItem>
                      {payments.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.date} · {formatInr(p.amount)} · {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>The ledger row that paid for it. One payment, one asset.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="purchaseDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Bought on</FormLabel>
                    <FormControl>
                      <Input type="date" disabled={isSubmitting} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cost"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Cost (₹) <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input type="number" inputMode="decimal" step="0.01" min="0" disabled={isSubmitting} {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="renewsOn"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Renews on{' '}
                    <span className="text-muted-foreground">
                      {kind === AssetKind.DIGITAL ? '(domain / subscription)' : '(optional)'}
                    </span>
                  </FormLabel>
                  <FormControl>
                    <Input type="date" disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormDescription>Shows up on the Dues page 30 days before.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {mode === 'create' ? (
              <div className="grid gap-4 rounded-md border p-3 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="holder"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Who has it</FormLabel>
                      <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent className="max-h-72">
                          <SelectItem value={COMPANY}>Nobody — with the company</SelectItem>
                          {people.users.length > 0 ? (
                            <SelectGroup>
                              <SelectLabel>Team</SelectLabel>
                              {people.users.map((u) => (
                                <SelectItem key={u.id} value={`user:${u.id}`}>
                                  {u.name}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ) : null}
                          {people.parties.length > 0 ? (
                            <SelectGroup>
                              <SelectLabel>Parties</SelectLabel>
                              {people.parties.map((p) => (
                                <SelectItem key={p.id} value={`party:${p.id}`}>
                                  {p.name}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          ) : null}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="location"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        Where <span className="text-muted-foreground">(optional)</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="Office, their home…" autoComplete="off" disabled={isSubmitting} {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : (
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Status</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.values(AssetStatus).map((s) => (
                          <SelectItem key={s} value={s}>
                            {ASSET_STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      Sold or scrapped ends the current hand-over. To move it to someone, use Hand over.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea rows={3} maxLength={2000} disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </form>
        </Form>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" form="asset-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : mode === 'create' ? (
              'Add asset'
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
