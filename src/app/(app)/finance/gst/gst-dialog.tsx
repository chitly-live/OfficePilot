'use client';

/**
 * Add / edit one month's GST return. The accountant fills in how the
 * liability was settled: input tax credit (no cash) + cash paid, and if
 * known, which bank / card the cash left from.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Pencil, Plus } from 'lucide-react';
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
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { FINANCE_ACCOUNT_TYPE_LABELS, formatInr } from '@/lib/finance';
import type { GstReturnPublic } from '@/lib/schemas/gst';
import type { FinanceAccountType } from '@prisma/client';

import { NONE_VALUE, requestJson, toDateInputValue } from '../finance-ui';

/** `0` / missing → empty input, so the field shows a placeholder. */
function amountValue(v: number | null | undefined): string {
  return v && v > 0 ? String(v) : '';
}

const money = z
  .string()
  .trim()
  .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), 'Enter an amount');

const formSchema = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick a month'),
    itcClaimedIgst: money,
    itcClaimedCgst: money,
    itcClaimedSgst: money,
    itcUsedIgst: money,
    itcUsedCgst: money,
    itcUsedSgst: money,
    cashPaidIgst: money,
    cashPaidCgst: money,
    cashPaidSgst: money,
    paidOn: z.string().refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Invalid date'),
    cashAccountId: z.string(),
    reference: z.string().trim().max(120),
    notes: z.string().trim().max(2000),
  })
  .refine(
    (v) =>
      [
        v.itcClaimedIgst, v.itcClaimedCgst, v.itcClaimedSgst,
        v.itcUsedIgst, v.itcUsedCgst, v.itcUsedSgst,
        v.cashPaidIgst, v.cashPaidCgst, v.cashPaidSgst,
      ].some((n) => Number(n || 0) > 0),
    { message: 'Enter at least one amount', path: ['cashPaidSgst'] },
  );

type FormValues = z.infer<typeof formSchema>;

export interface GstAccountOption {
  id: string;
  name: string;
  type: FinanceAccountType;
}

export interface GstDialogProps {
  mode: 'create' | 'edit';
  gstReturn?: GstReturnPublic;
  accounts: GstAccountOption[];
  /** Preselect for a new return (YYYY-MM). */
  defaultMonth?: string;
  trigger?: React.ReactNode;
}

export function GstDialog({ mode, gstReturn, accounts, defaultMonth, trigger }: GstDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const defaults = React.useCallback(
    (): FormValues => ({
      month: gstReturn?.month ?? defaultMonth ?? '',
      itcClaimedIgst: amountValue(gstReturn?.itcClaimedIgst),
      itcClaimedCgst: amountValue(gstReturn?.itcClaimedCgst),
      itcClaimedSgst: amountValue(gstReturn?.itcClaimedSgst),
      itcUsedIgst: amountValue(gstReturn?.itcUsedIgst),
      itcUsedCgst: amountValue(gstReturn?.itcUsedCgst),
      itcUsedSgst: amountValue(gstReturn?.itcUsedSgst),
      cashPaidIgst: amountValue(gstReturn?.cashPaidIgst),
      cashPaidCgst: amountValue(gstReturn?.cashPaidCgst),
      cashPaidSgst: amountValue(gstReturn?.cashPaidSgst),
      paidOn: toDateInputValue(gstReturn?.paidOn ?? null),
      cashAccountId: gstReturn?.cashAccountId ?? NONE_VALUE,
      reference: gstReturn?.reference ?? '',
      notes: gstReturn?.notes ?? '',
    }),
    [gstReturn, defaultMonth],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(),
  });
  const isSubmitting = form.formState.isSubmitting;
  const w = form.watch();
  const n = (v: string | undefined) => Number(v || 0);
  const claimed = n(w.itcClaimedIgst) + n(w.itcClaimedCgst) + n(w.itcClaimedSgst);
  const itc = n(w.itcUsedIgst) + n(w.itcUsedCgst) + n(w.itcUsedSgst);
  const cash = n(w.cashPaidIgst) + n(w.cashPaidCgst) + n(w.cashPaidSgst);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) form.reset(defaults());
  };

  async function onSubmit(values: FormValues) {
    const num = (v: string) => (v === '' ? 0 : Number(v));
    const payload: Record<string, unknown> = {
      itcClaimedIgst: num(values.itcClaimedIgst),
      itcClaimedCgst: num(values.itcClaimedCgst),
      itcClaimedSgst: num(values.itcClaimedSgst),
      itcUsedIgst: num(values.itcUsedIgst),
      itcUsedCgst: num(values.itcUsedCgst),
      itcUsedSgst: num(values.itcUsedSgst),
      cashPaidIgst: num(values.cashPaidIgst),
      cashPaidCgst: num(values.cashPaidCgst),
      cashPaidSgst: num(values.cashPaidSgst),
      paidOn: values.paidOn === '' ? null : values.paidOn,
      cashAccountId: values.cashAccountId === NONE_VALUE ? null : values.cashAccountId,
      reference: values.reference === '' ? null : values.reference,
      notes: values.notes === '' ? null : values.notes,
    };
    const result =
      mode === 'create'
        ? await requestJson('/api/finance/gst', {
            method: 'POST',
            json: { month: values.month, ...payload },
          })
        : await requestJson(`/api/finance/gst/${gstReturn?.id}`, { method: 'PATCH', json: payload });

    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(mode === 'create' ? 'GST return saved.' : 'GST return updated.');
    setOpen(false);
    router.refresh();
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button type="button" size="sm" variant={mode === 'create' ? 'default' : 'ghost'}>
            {mode === 'create' ? (
              <>
                <Plus className="h-4 w-4" aria-hidden="true" />
                <span>Add month</span>
              </>
            ) : (
              <>
                <Pencil className="h-4 w-4" aria-hidden="true" />
                <span>Edit</span>
              </>
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'Record a GST return' : 'Edit GST return'}</DialogTitle>
          <DialogDescription>
            Enter the return head-wise, exactly as filed: IGST for inter-state, CGST + SGST for
            intra-state. Each head shows the credit claimed that month and how the liability was
            settled — from credit or in cash. Saving writes the paid amounts into the ledger
            under Government (GST); the claim only moves the ITC balance.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form id="gst-return-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="month"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Tax period</FormLabel>
                  <FormControl>
                    <Input type="month" disabled={isSubmitting || mode === 'edit'} {...field} />
                  </FormControl>
                  <FormDescription>The month the return covers, e.g. August for the return filed in September.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="space-y-2">
              <div className="grid grid-cols-[3.2rem_1fr_1fr_1fr] items-end gap-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Head
                </span>
                <span className="text-xs font-medium text-muted-foreground">ITC claimed</span>
                <span className="text-xs font-medium text-muted-foreground">Paid by ITC</span>
                <span className="text-xs font-medium text-muted-foreground">Paid in cash</span>
              </div>
              {(
                [
                  ['igst', 'IGST', 'itcClaimedIgst', 'itcUsedIgst', 'cashPaidIgst'],
                  ['cgst', 'CGST', 'itcClaimedCgst', 'itcUsedCgst', 'cashPaidCgst'],
                  ['sgst', 'SGST', 'itcClaimedSgst', 'itcUsedSgst', 'cashPaidSgst'],
                ] as const
              ).map(([key, label, claimName, usedName, cashName]) => (
                <div key={key} className="grid grid-cols-[3.2rem_1fr_1fr_1fr] items-center gap-2">
                  <span className="text-sm font-medium text-foreground">{label}</span>
                  {([claimName, usedName, cashName] as const).map((fieldName) => (
                    <FormField
                      key={fieldName}
                      control={form.control}
                      name={fieldName}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="sr-only">{`${label} ${fieldName}`}</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="decimal"
                              placeholder="0"
                              className="h-9 text-right tabular-nums"
                              disabled={isSubmitting}
                              {...field}
                            />
                          </FormControl>
                        </FormItem>
                      )}
                    />
                  ))}
                </div>
              ))}
              <div className="grid grid-cols-[3.2rem_1fr_1fr_1fr] items-center gap-2 border-t pt-2">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Total
                </span>
                <span className="pr-3 text-right text-sm font-semibold tabular-nums text-status-green">
                  {formatInr(claimed)}
                </span>
                <span className="pr-3 text-right text-sm font-semibold tabular-nums">
                  {formatInr(itc)}
                </span>
                <span className="pr-3 text-right text-sm font-semibold tabular-nums text-status-red">
                  {formatInr(cash)}
                </span>
              </div>
              <FormMessage>{form.formState.errors.cashPaidSgst?.message}</FormMessage>
            </div>

            <div className="grid gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm sm:grid-cols-2">
              <div>
                Total GST paid:{' '}
                <span className="font-semibold tabular-nums">{formatInr(itc + cash)}</span>
              </div>
              <div>
                ITC change this month:{' '}
                <span
                  className={
                    claimed - itc >= 0
                      ? 'font-semibold tabular-nums text-status-green'
                      : 'font-semibold tabular-nums text-status-red'
                  }
                >
                  {claimed - itc >= 0 ? '+' : '−'}
                  {formatInr(Math.abs(claimed - itc))}
                </span>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="paidOn"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Paid on <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input type="date" disabled={isSubmitting} {...field} />
                    </FormControl>
                    <FormDescription>Defaults to the 20th of the next month.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cashAccountId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Cash paid from <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={isSubmitting}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE_VALUE}>— Not sure yet —</SelectItem>
                        {accounts.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                            <span className="ml-1 text-xs text-muted-foreground">
                              · {FINANCE_ACCOUNT_TYPE_LABELS[a.type]}
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>Which bank or card the cash left from.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <FormField
              control={form.control}
              name="reference"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Challan / ARN <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input maxLength={120} disabled={isSubmitting} {...field} />
                  </FormControl>
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
                    <Textarea rows={2} maxLength={2000} disabled={isSubmitting} {...field} />
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
          <Button type="submit" form="gst-return-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : mode === 'create' ? (
              'Save return'
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
