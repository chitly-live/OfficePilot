'use client';

/**
 * Create / edit dialog for a finance account (bank, cash, UPI, credit
 * card, wallet). Setting an owner party marks the instrument as
 * borrowed: spend on it accrues to what we owe that party.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import { FinanceAccountType, type FinancePartyType } from '@prisma/client';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ALL_FINANCE_ACCOUNT_TYPES,
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_PARTY_TYPE_SHORT,
} from '@/lib/finance';

import { NONE_VALUE, requestJson } from '../finance-ui';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  type: z.nativeEnum(FinanceAccountType),
  ownerPartyId: z.string(),
  openingBalance: z
    .string()
    .trim()
    .refine((v) => v === '' || Number.isFinite(Number(v)), 'Enter a number'),
  creditLimit: z
    .string()
    .trim()
    .refine((v) => v === '' || (Number.isFinite(Number(v)) && Number(v) >= 0), 'Enter a number'),
  billingDay: z
    .string()
    .trim()
    .refine((v) => v === '' || /^([1-9]|[12]\d|3[01])$/.test(v), 'Day 1–31'),
  dueDay: z
    .string()
    .trim()
    .refine((v) => v === '' || /^([1-9]|[12]\d|3[01])$/.test(v), 'Day 1–31'),
  notes: z.string().trim().max(2000),
  isActive: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export interface AccountDialogAccount {
  id: string;
  name: string;
  type: FinanceAccountType;
  ownerPartyId: string | null;
  openingBalance: number;
  notes: string | null;
  isActive: boolean;
  creditLimit: number | null;
  billingDay: number | null;
  dueDay: number | null;
}

export interface AccountDialogPartyOption {
  id: string;
  name: string;
  type: FinancePartyType;
}

export interface AccountDialogProps {
  mode: 'create' | 'edit';
  account?: AccountDialogAccount;
  parties: AccountDialogPartyOption[];
  trigger?: React.ReactNode;
}

export function AccountDialog({ mode, account, parties, trigger }: AccountDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const defaults = React.useCallback(
    (): FormValues => ({
      name: account?.name ?? '',
      type: account?.type ?? FinanceAccountType.BANK,
      ownerPartyId: account?.ownerPartyId ?? NONE_VALUE,
      openingBalance:
        account && account.openingBalance !== 0 ? String(account.openingBalance) : '',
      creditLimit: account?.creditLimit != null ? String(account.creditLimit) : '',
      billingDay: account?.billingDay != null ? String(account.billingDay) : '',
      dueDay: account?.dueDay != null ? String(account.dueDay) : '',
      notes: account?.notes ?? '',
      isActive: account?.isActive ?? true,
    }),
    [account],
  );

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: defaults(),
  });

  const isSubmitting = form.formState.isSubmitting;
  const type = form.watch('type');

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) form.reset(defaults());
  };

  async function onSubmit(values: FormValues) {
    const opening = values.openingBalance === '' ? 0 : Number(values.openingBalance);
    // Card fields only make sense on credit cards; clear them otherwise.
    const isCard = values.type === 'CREDIT_CARD';
    const cardValues = {
      creditLimit: isCard && values.creditLimit !== '' ? Number(values.creditLimit) : null,
      billingDay: isCard && values.billingDay !== '' ? Number(values.billingDay) : null,
      dueDay: isCard && values.dueDay !== '' ? Number(values.dueDay) : null,
    };
    const card =
      mode === 'create'
        ? Object.fromEntries(Object.entries(cardValues).filter(([, v]) => v !== null))
        : cardValues;
    const payload: Record<string, unknown> =
      mode === 'create'
        ? {
            name: values.name,
            type: values.type,
            openingBalance: opening,
            ...card,
            ...(values.ownerPartyId !== NONE_VALUE
              ? { ownerPartyId: values.ownerPartyId }
              : {}),
            ...(values.notes !== '' ? { notes: values.notes } : {}),
          }
        : {
            name: values.name,
            type: values.type,
            openingBalance: opening,
            ...card,
            ownerPartyId: values.ownerPartyId === NONE_VALUE ? null : values.ownerPartyId,
            notes: values.notes === '' ? null : values.notes,
            isActive: values.isActive,
          };

    const result =
      mode === 'create'
        ? await requestJson('/api/finance/accounts', { method: 'POST', json: payload })
        : await requestJson(`/api/finance/accounts/${account?.id}`, {
            method: 'PATCH',
            json: payload,
          });

    if (!result.ok) {
      toast.error(result.message);
      return;
    }
    toast.success(mode === 'create' ? 'Account added.' : 'Account updated.');
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
                <span>New account</span>
              </>
            ) : (
              'Edit'
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New account' : 'Edit account'}</DialogTitle>
          <DialogDescription>
            Bank, cash, UPI, wallet — or a credit card someone lent us.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="finance-account-form"
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
                      placeholder="HDFC current a/c · Rahul's ICICI card · Cash box"
                      autoComplete="off"
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
                        {ALL_FINANCE_ACCOUNT_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {FINANCE_ACCOUNT_TYPE_LABELS[t]}
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
                name="openingBalance"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Opening balance (₹){' '}
                      <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        step="any"
                        placeholder="0"
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
              name="ownerPartyId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Belongs to{' '}
                    <span className="text-muted-foreground">
                      {type === 'CREDIT_CARD' ? '(card owner)' : '(optional)'}
                    </span>
                  </FormLabel>
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
                      <SelectItem value={NONE_VALUE}>— Ours (company) —</SelectItem>
                      {parties.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                          <span className="ml-1 text-xs text-muted-foreground">
                            · {FINANCE_PARTY_TYPE_SHORT[p.type]}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    If someone else owns it, every rupee spent through it is added to what
                    we owe them until you record a card repayment.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            {type === 'CREDIT_CARD' ? (
              <div className="grid gap-4 rounded-md border bg-muted/20 p-3 sm:grid-cols-3">
                <FormField
                  control={form.control}
                  name="creditLimit"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Credit limit (₹)</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="any"
                          placeholder="60000"
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
                  name="billingDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Statement day</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={31}
                          placeholder="13"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>Bill generates on this day.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="dueDay"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Due day</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          inputMode="numeric"
                          min={1}
                          max={31}
                          placeholder="1"
                          disabled={isSubmitting}
                          {...field}
                        />
                      </FormControl>
                      <FormDescription>First such day after the statement.</FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            ) : null}

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
                      rows={2}
                      maxLength={2000}
                      placeholder="Last 4 digits, statement date, limit…"
                      disabled={isSubmitting}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {mode === 'edit' ? (
              <FormField
                control={form.control}
                name="isActive"
                render={({ field }) => (
                  <FormItem className="flex items-center justify-between rounded-md border p-3">
                    <div className="space-y-0.5">
                      <FormLabel className="text-sm">Active</FormLabel>
                      <FormDescription>
                        Inactive accounts are hidden from the new-transaction picker.
                      </FormDescription>
                    </div>
                    <FormControl>
                      <Switch
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        disabled={isSubmitting}
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            ) : null}
          </form>
        </Form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="submit" form="finance-account-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : mode === 'create' ? (
              'Add account'
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
