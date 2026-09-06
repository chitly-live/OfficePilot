'use client';

/**
 * Create / edit form for one ledger row. Shared by
 * `/finance/transactions/new` and `/finance/transactions/[id]`.
 *
 * Validation mirrors `financeTransactionCreateSchema` client-side (via
 * zod + react-hook-form) so the server is the last line of defence, not
 * the first. Numeric inputs are strings in form state (browser inputs
 * are strings) and coerced on submit.
 */

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowDownLeft, ArrowUpRight, Loader2 } from 'lucide-react';
import {
  FinanceCategory,
  FinanceDirection,
  type FinanceAccountType,
  type FinancePartyType,
} from '@prisma/client';
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
import {
  FINANCE_ACCOUNT_TYPE_LABELS,
  FINANCE_CATEGORY_META,
  FINANCE_PARTY_TYPE_SHORT,
  categoriesForDirection,
  categoryDirection,
} from '@/lib/finance';
import { cn } from '@/lib/utils';

import { NONE_VALUE, requestJson, todayLocalDateKey } from '../finance-ui';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const formSchema = z
  .object({
    direction: z.nativeEnum(FinanceDirection),
    date: z.string().regex(DATE_RE, 'Pick a date'),
    amount: z
      .string()
      .trim()
      .min(1, 'Amount is required')
      .refine((v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0;
      }, 'Amount must be greater than zero'),
    category: z.nativeEnum(FinanceCategory),
    partyId: z.string(),
    viaPartyId: z.string(),
    accountId: z.string(),
    settlesAccountId: z.string(),
    description: z
      .string()
      .trim()
      .max(500, 'Description must be 500 characters or fewer'),
    reference: z
      .string()
      .trim()
      .max(100, 'Reference must be 100 characters or fewer'),
    hasOriginal: z.boolean(),
    originalAmount: z.string().trim(),
    originalCurrency: z.string().trim(),
    dueDate: z.string().refine((v) => v === '' || DATE_RE.test(v), 'Invalid date'),
  })
  .refine((v) => categoryDirection(v.category) === v.direction, {
    message: 'Pick a category that matches Money in / Money out',
    path: ['category'],
  })
  .refine(
    (v) =>
      v.viaPartyId === NONE_VALUE ||
      v.partyId === NONE_VALUE ||
      v.viaPartyId !== v.partyId,
    {
      message: 'The routed-via person must be different from the party',
      path: ['viaPartyId'],
    },
  )
  .refine(
    (v) => {
      if (!v.hasOriginal) return true;
      const n = Number(v.originalAmount);
      return Number.isFinite(n) && n > 0;
    },
    { message: 'Enter the original amount', path: ['originalAmount'] },
  )
  .refine((v) => !v.hasOriginal || /^[A-Za-z]{3}$/.test(v.originalCurrency), {
    message: '3-letter currency code, e.g. USD',
    path: ['originalCurrency'],
  });

type FormValues = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface PartyOption {
  id: string;
  name: string;
  type: FinancePartyType;
}

export interface AccountOption {
  id: string;
  name: string;
  type: FinanceAccountType;
  ownerName: string | null;
}

export interface TransactionFormProps {
  mode: 'create' | 'edit';
  /** Required in edit mode. */
  transactionId?: string;
  parties: PartyOption[];
  accounts: AccountOption[];
  /** Pre-filled values (edit mode, or `?direction=` style prefills). */
  initialValues?: Partial<FormValues>;
  /** Where to go after a successful save. */
  returnTo?: string;
}

const DEFAULT_CATEGORY: Record<FinanceDirection, FinanceCategory> = {
  IN: 'SALES',
  OUT: 'ADS',
};

export function TransactionForm({
  mode,
  transactionId,
  parties,
  accounts,
  initialValues,
  returnTo,
}: TransactionFormProps) {
  const router = useRouter();

  const initialDirection = initialValues?.direction ?? 'OUT';
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      direction: initialDirection,
      date: initialValues?.date ?? todayLocalDateKey(),
      amount: initialValues?.amount ?? '',
      category:
        initialValues?.category &&
        categoryDirection(initialValues.category) === initialDirection
          ? initialValues.category
          : DEFAULT_CATEGORY[initialDirection],
      partyId: initialValues?.partyId ?? NONE_VALUE,
      viaPartyId: initialValues?.viaPartyId ?? NONE_VALUE,
      accountId: initialValues?.accountId ?? NONE_VALUE,
      settlesAccountId: initialValues?.settlesAccountId ?? NONE_VALUE,
      description: initialValues?.description ?? '',
      reference: initialValues?.reference ?? '',
      hasOriginal: initialValues?.hasOriginal ?? false,
      originalAmount: initialValues?.originalAmount ?? '',
      originalCurrency: initialValues?.originalCurrency ?? 'USD',
      dueDate: initialValues?.dueDate ?? '',
    },
  });

  const isSubmitting = form.formState.isSubmitting;
  const direction = form.watch('direction');
  const category = form.watch('category');
  const hasOriginal = form.watch('hasOriginal');

  // Keep the category consistent when the user flips direction.
  React.useEffect(() => {
    if (categoryDirection(category) !== direction) {
      form.setValue('category', DEFAULT_CATEGORY[direction], {
        shouldValidate: true,
      });
    }
  }, [direction, category, form]);

  const categoryOptions = React.useMemo(
    () => categoriesForDirection(direction),
    [direction],
  );

  const showDueDate =
    category === 'LOAN_RECEIVED' || category === 'LOAN_REPAYMENT';

  async function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> = {
      date: values.date,
      direction: values.direction,
      category: values.category,
      amount: Number(values.amount),
      description: values.description,
      reference: values.reference,
    };

    if (mode === 'create') {
      if (values.partyId !== NONE_VALUE) payload.partyId = values.partyId;
      if (values.viaPartyId !== NONE_VALUE) payload.viaPartyId = values.viaPartyId;
      if (values.accountId !== NONE_VALUE) payload.accountId = values.accountId;
      if (values.category === 'CARD_REPAYMENT' && values.settlesAccountId !== NONE_VALUE) {
        payload.settlesAccountId = values.settlesAccountId;
      }
      if (values.hasOriginal) {
        payload.originalAmount = Number(values.originalAmount);
        payload.originalCurrency = values.originalCurrency.toUpperCase();
      }
      if (values.dueDate !== '') payload.dueDate = values.dueDate;
      // Empty optional strings are dropped so the API's `.optional()`
      // fields see `undefined`, not `''`.
      if (values.description === '') delete payload.description;
      if (values.reference === '') delete payload.reference;
    } else {
      payload.partyId = values.partyId === NONE_VALUE ? null : values.partyId;
      payload.viaPartyId =
        values.viaPartyId === NONE_VALUE ? null : values.viaPartyId;
      payload.settlesAccountId =
        values.category === 'CARD_REPAYMENT' && values.settlesAccountId !== NONE_VALUE
          ? values.settlesAccountId
          : null;
      payload.accountId =
        values.accountId === NONE_VALUE ? null : values.accountId;
      payload.originalAmount = values.hasOriginal
        ? Number(values.originalAmount)
        : null;
      payload.originalCurrency = values.hasOriginal
        ? values.originalCurrency.toUpperCase()
        : null;
      payload.dueDate = values.dueDate === '' ? null : values.dueDate;
    }

    const result =
      mode === 'create'
        ? await requestJson<{ id: string }>('/api/finance/transactions', {
            method: 'POST',
            json: payload,
          })
        : await requestJson<{ id: string }>(
            `/api/finance/transactions/${transactionId}`,
            { method: 'PATCH', json: payload },
          );

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(mode === 'create' ? 'Transaction recorded.' : 'Transaction updated.');
    router.push(returnTo ?? '/finance/transactions');
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="space-y-5"
        noValidate
      >
        {/* Direction toggle */}
        <FormField
          control={form.control}
          name="direction"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Type</FormLabel>
              <FormControl>
                <div
                  role="radiogroup"
                  aria-label="Money in or out"
                  className="grid grid-cols-2 gap-2"
                >
                  {(['IN', 'OUT'] as const).map((d) => {
                    const selected = field.value === d;
                    const Icon = d === 'IN' ? ArrowDownLeft : ArrowUpRight;
                    return (
                      <button
                        key={d}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={isSubmitting}
                        onClick={() => field.onChange(d)}
                        className={cn(
                          'flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          selected
                            ? d === 'IN'
                              ? 'border-status-green bg-status-green/10 text-status-green'
                              : 'border-status-red bg-status-red/10 text-status-red'
                            : 'bg-background text-muted-foreground hover:bg-accent',
                        )}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                        {d === 'IN' ? 'Money in' : 'Money out'}
                      </button>
                    );
                  })}
                </div>
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="date"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Date</FormLabel>
                <FormControl>
                  <Input type="date" disabled={isSubmitting} {...field} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="amount"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Amount (₹)</FormLabel>
                <FormControl>
                  <Input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="6000"
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
          name="category"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Category</FormLabel>
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
                  {categoryOptions.map((c) => (
                    <SelectItem key={c} value={c}>
                      {FINANCE_CATEGORY_META[c].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FormDescription>{FINANCE_CATEGORY_META[category].hint}</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            control={form.control}
            name="partyId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  {direction === 'IN' ? 'From (party)' : 'To (party)'}{' '}
                  <span className="text-muted-foreground">(optional)</span>
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
                    <SelectItem value={NONE_VALUE}>— No party —</SelectItem>
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
                  Financer, card owner, host, vendor… Manage them under{' '}
                  <Link href="/finance/parties" className="underline">
                    Parties
                  </Link>
                  .
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          <FormField
            control={form.control}
            name="accountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Paid {direction === 'IN' ? 'into' : 'from'} (account){' '}
                  <span className="text-muted-foreground">(optional)</span>
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
                    <SelectItem value={NONE_VALUE}>— No account —</SelectItem>
                    {accounts.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          · {FINANCE_ACCOUNT_TYPE_LABELS[a.type]}
                          {a.ownerName ? ` (${a.ownerName})` : ''}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Spend on someone else&apos;s card is automatically added to what
                  we owe them.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        </div>

        <FormField
          control={form.control}
          name="viaPartyId"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Routed via <span className="text-muted-foreground">(optional)</span>
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
                  <SelectItem value={NONE_VALUE}>— Direct, nobody in between —</SelectItem>
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
                Use when the bank paid someone else who passed the money on
                (e.g. bank → Ritu → Shubham). The party above still gets the
                credit; the person here is only shown as the route.
              </FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />

        {category === 'CARD_REPAYMENT' ? (
          <FormField
            control={form.control}
            name="settlesAccountId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Which card does this settle?{' '}
                  <span className="text-muted-foreground">(optional)</span>
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
                    <SelectItem value={NONE_VALUE}>— Not tracked per card —</SelectItem>
                    {accounts
                      .filter((a) => a.type === 'CREDIT_CARD')
                      .map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                          {a.ownerName ? (
                            <span className="ml-1 text-xs text-muted-foreground">
                              · {a.ownerName}
                            </span>
                          ) : null}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Frees up that card&apos;s limit. What we owe the card owner is
                  reduced either way.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        <FormField
          control={form.control}
          name="description"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                Description <span className="text-muted-foreground">(optional)</span>
              </FormLabel>
              <FormControl>
                <Textarea
                  rows={2}
                  maxLength={500}
                  placeholder="Facebook ads — Aug week 1"
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
            name="reference"
            render={({ field }) => (
              <FormItem>
                <FormLabel>
                  Reference <span className="text-muted-foreground">(optional)</span>
                </FormLabel>
                <FormControl>
                  <Input
                    placeholder="UTR / invoice no."
                    autoComplete="off"
                    disabled={isSubmitting}
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {showDueDate ? (
            <FormField
              control={form.control}
              name="dueDate"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Due date <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Input type="date" disabled={isSubmitting} {...field} />
                  </FormControl>
                  <FormDescription>When this loan is expected back.</FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />
          ) : null}
        </div>

        {/* Foreign currency */}
        <fieldset className="space-y-3 rounded-md border bg-muted/20 p-4">
          <FormField
            control={form.control}
            name="hasOriginal"
            render={({ field }) => (
              <FormItem className="flex flex-row items-center gap-2 space-y-0">
                <FormControl>
                  <Checkbox
                    id="txn-has-original"
                    checked={field.value}
                    onCheckedChange={(v) => field.onChange(v === true)}
                    disabled={isSubmitting}
                  />
                </FormControl>
                <FormLabel
                  htmlFor="txn-has-original"
                  className="cursor-pointer text-sm font-normal"
                >
                  Paid in a foreign currency (e.g. $299 that cost ₹29,722)
                </FormLabel>
              </FormItem>
            )}
          />
          {hasOriginal ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="originalAmount"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Original amount</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        inputMode="decimal"
                        min={0}
                        step="any"
                        placeholder="299"
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
                name="originalCurrency"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Currency</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="USD"
                        maxLength={3}
                        autoComplete="off"
                        disabled={isSubmitting}
                        {...field}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
          ) : null}
        </fieldset>

        <div className="flex items-center justify-end gap-2 pt-2">
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={() => router.push(returnTo ?? '/finance/transactions')}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : mode === 'create' ? (
              'Record transaction'
            ) : (
              'Save changes'
            )}
          </Button>
        </div>
      </form>
    </Form>
  );
}
