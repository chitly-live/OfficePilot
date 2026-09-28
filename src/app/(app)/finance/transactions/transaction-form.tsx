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
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronDown,
  Loader2,
  Plus,
  TriangleAlert,
  X,
} from 'lucide-react';
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
  formatDateUtc,
  formatInr,
  round2,
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
    productId: z.string(),
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

export interface ProductFormOption {
  id: string;
  name: string;
  color: string | null;
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
  /** Products (business lines) the row can be tagged with. */
  products?: ProductFormOption[];
  /** Pre-filled values (edit mode, or `?direction=` style prefills). */
  initialValues?: Partial<FormValues>;
  /** Edit mode: the per-card split this payment already carries. */
  initialSplit?: { accountId: string; amount: number }[];
  /** Where to go after a successful save. */
  returnTo?: string;
}

interface SplitPart {
  accountId: string;
  amount: string;
}

interface DuplicateHit {
  id: string;
  date: string;
  amount: number;
  description: string | null;
  accountName: string | null;
  reference: string | null;
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
  products = [],
  initialValues,
  initialSplit = [],
  returnTo,
}: TransactionFormProps) {
  const router = useRouter();
  const cards = React.useMemo(() => accounts.filter((a) => a.type === 'CREDIT_CARD'), [accounts]);

  // One payment that cleared several cards: each card's share.
  const [splitMode, setSplitMode] = React.useState(initialSplit.length > 0);
  const [splitParts, setSplitParts] = React.useState<SplitPart[]>(
    initialSplit.length > 0
      ? initialSplit.map((p) => ({ accountId: p.accountId, amount: String(p.amount) }))
      : [
          { accountId: '', amount: '' },
          { accountId: '', amount: '' },
        ],
  );
  const [splitError, setSplitError] = React.useState<string | null>(null);

  // Rows the server thinks this entry may duplicate; saving again confirms.
  const [duplicates, setDuplicates] = React.useState<DuplicateHit[] | null>(null);

  // Rarely needed fields stay folded unless the row already uses them.
  const [showMore, setShowMore] = React.useState(
    Boolean(
      (initialValues?.viaPartyId && initialValues.viaPartyId !== NONE_VALUE) ||
        initialValues?.hasOriginal ||
        initialValues?.dueDate,
    ),
  );

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
      productId: initialValues?.productId ?? products[0]?.id ?? NONE_VALUE,
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

  const amountValue = Number(form.watch('amount')) || 0;
  const splitTotal = round2(splitParts.reduce((s, p) => s + (Number(p.amount) || 0), 0));

  function checkSplit(amount: number): { accountId: string; amount: number }[] | null {
    const parts = splitParts
      .filter((p) => p.accountId !== '' || p.amount !== '')
      .map((p) => ({ accountId: p.accountId, amount: Number(p.amount) }));
    if (parts.length < 2) return (setSplitError('Add at least two cards, or switch back to one card.'), null);
    if (parts.some((p) => !p.accountId)) return (setSplitError('Pick a card on every line.'), null);
    if (new Set(parts.map((p) => p.accountId)).size !== parts.length) {
      return (setSplitError('Each card can appear only once.'), null);
    }
    if (parts.some((p) => !(p.amount > 0))) return (setSplitError('Every card needs an amount above zero.'), null);
    const total = round2(parts.reduce((s, p) => s + p.amount, 0));
    if (Math.abs(total - round2(amount)) >= 0.005) {
      return (setSplitError(`The cards add up to ${formatInr(total)} but the payment is ${formatInr(amount)}.`), null);
    }
    setSplitError(null);
    return parts;
  }

  async function onSubmit(values: FormValues, confirmDuplicate = false) {
    const isRepayment = values.category === 'CARD_REPAYMENT';
    const split = isRepayment && splitMode ? checkSplit(Number(values.amount)) : [];
    if (split === null) return;

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
      if (isRepayment && split.length > 0) {
        payload.cardSplit = split;
      } else if (isRepayment && values.settlesAccountId !== NONE_VALUE) {
        payload.settlesAccountId = values.settlesAccountId;
      }
      if (values.productId !== NONE_VALUE) payload.productId = values.productId;
      if (confirmDuplicate) payload.confirmDuplicate = true;
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
        isRepayment && split.length === 0 && values.settlesAccountId !== NONE_VALUE
          ? values.settlesAccountId
          : null;
      if (isRepayment) payload.cardSplit = split;
      payload.accountId =
        values.accountId === NONE_VALUE ? null : values.accountId;
      payload.productId = values.productId === NONE_VALUE ? null : values.productId;
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
      const hits = result.body?.duplicates;
      if (result.status === 409 && Array.isArray(hits)) {
        setDuplicates(hits as DuplicateHit[]);
        return;
      }
      toast.error(result.message);
      return;
    }

    setDuplicates(null);
    toast.success(mode === 'create' ? 'Transaction recorded.' : 'Transaction updated.');
    router.push(returnTo ?? '/finance/transactions');
    router.refresh();
  }

  return (
    <Form {...form}>
      <form
        onSubmit={form.handleSubmit((v) => onSubmit(v))}
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

        {products.length > 1 ? (
          <FormField
            control={form.control}
            name="productId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Product</FormLabel>
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
                    {products.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        <span className="inline-flex items-center gap-2">
                          <span
                            aria-hidden="true"
                            className="inline-block h-2 w-2 rounded-full"
                            style={{ backgroundColor: p.color ?? '#94a3b8' }}
                          />
                          {p.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FormDescription>
                  Which business line this entry belongs to. Every entry belongs to one
                  product; switch products in the top bar to see them apart.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />
        ) : null}

        {category === 'CARD_REPAYMENT' ? (
          <div className="space-y-3 rounded-md border p-4">
            {splitMode ? (
              <div className="space-y-2">
                <p className="text-sm font-medium">Cards this one payment cleared</p>
                {splitParts.map((part, i) => (
                  <div key={i} className="flex gap-2">
                    <Select
                      value={part.accountId || undefined}
                      onValueChange={(v) =>
                        setSplitParts((prev) => prev.map((p, j) => (j === i ? { ...p, accountId: v } : p)))
                      }
                      disabled={isSubmitting}
                    >
                      <SelectTrigger className="flex-1" aria-label={`Card ${i + 1}`}>
                        <SelectValue placeholder="Pick a card" />
                      </SelectTrigger>
                      <SelectContent>
                        {cards.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      inputMode="decimal"
                      min={0}
                      step="any"
                      placeholder="₹"
                      className="w-32"
                      aria-label={`Amount for card ${i + 1}`}
                      value={part.amount}
                      onChange={(e) =>
                        setSplitParts((prev) => prev.map((p, j) => (j === i ? { ...p, amount: e.target.value } : p)))
                      }
                      disabled={isSubmitting}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label="Remove card"
                      disabled={isSubmitting || splitParts.length <= 2}
                      onClick={() => setSplitParts((prev) => prev.filter((_, j) => j !== i))}
                    >
                      <X className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isSubmitting || splitParts.length >= cards.length}
                    onClick={() => setSplitParts((prev) => [...prev, { accountId: '', amount: '' }])}
                  >
                    <Plus className="h-4 w-4" aria-hidden="true" />
                    <span>Add card</span>
                  </Button>
                  <span
                    className={cn(
                      'tabular-nums',
                      Math.abs(splitTotal - round2(amountValue)) < 0.005 ? 'text-status-green' : 'text-status-amber',
                    )}
                  >
                    {formatInr(splitTotal)} of {formatInr(amountValue)}
                    {Math.abs(splitTotal - round2(amountValue)) >= 0.005
                      ? ` · ${formatInr(round2(amountValue - splitTotal))} left`
                      : ' · adds up'}
                  </span>
                </div>
                {splitError ? <p className="text-sm text-destructive">{splitError}</p> : null}
                <p className="text-xs text-muted-foreground">
                  The ledger keeps this as one payment, exactly as the bank shows it. The split only decides how much of
                  each card&apos;s limit it frees.
                </p>
              </div>
            ) : (
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
            )}
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => {
                setSplitMode((v) => !v);
                setSplitError(null);
              }}
              disabled={isSubmitting}
            >
              {splitMode ? 'Settles just one card' : 'This one payment cleared more than one card →'}
            </button>
          </div>
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
                <FormDescription>The UTR from the bank statement lets Reconcile match it.</FormDescription>
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

        <div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
            onClick={() => setShowMore((v) => !v)}
            aria-expanded={showMore}
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', showMore && 'rotate-180')} aria-hidden="true" />
            More details
            <span className="font-normal">(routed via someone, foreign currency)</span>
          </button>
        </div>

        {showMore ? (
          <div className="space-y-5">
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
          </div>
        ) : null}

        {duplicates && duplicates.length > 0 ? (
          <div className="rounded-md border border-status-amber/50 bg-status-amber/5 p-3 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <TriangleAlert className="h-4 w-4 text-status-amber" aria-hidden="true" />
              This looks like an entry you already made
            </p>
            <ul className="mt-2 space-y-1">
              {duplicates.map((d) => (
                <li key={d.id} className="flex flex-wrap justify-between gap-x-4">
                  <Link href={`/finance/transactions/${d.id}`} className="hover:underline" target="_blank">
                    {formatDateUtc(d.date)} · {d.description ?? 'No description'}
                    {d.accountName ? <span className="text-muted-foreground"> · {d.accountName}</span> : null}
                    {d.reference ? (
                      <span className="font-mono text-xs text-muted-foreground"> · {d.reference}</span>
                    ) : null}
                  </Link>
                  <span className="tabular-nums">{formatInr(d.amount)}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={isSubmitting}
                onClick={form.handleSubmit((v) => onSubmit(v, true))}
              >
                It is a separate payment — save it
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setDuplicates(null)}>
                Let me check
              </Button>
            </div>
          </div>
        ) : null}

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
