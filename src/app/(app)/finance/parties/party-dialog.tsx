'use client';

/**
 * Create / edit dialog for a finance party (financer, card owner, host /
 * worker, vendor, client). Small enough to live in a dialog rather than
 * its own page.
 */

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Plus } from 'lucide-react';
import { FinancePartyType } from '@prisma/client';
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
  ALL_FINANCE_PARTY_TYPES,
  FINANCE_PARTY_TYPE_LABELS,
} from '@/lib/finance';

import { requestJson } from '../finance-ui';

const phoneRegex = /^[+\d][\d\s\-()]{6,}$/;

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  type: z.nativeEnum(FinancePartyType),
  phone: z
    .string()
    .trim()
    .max(32)
    .refine((v) => v === '' || phoneRegex.test(v), 'Invalid phone number'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((v) => v === '' || /^\S+@\S+\.\S+$/.test(v), 'Invalid email address'),
  notes: z.string().trim().max(2000, 'Notes must be 2000 characters or fewer'),
  isActive: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export interface PartyDialogParty {
  id: string;
  name: string;
  type: FinancePartyType;
  phone: string | null;
  email: string | null;
  notes: string | null;
  isActive: boolean;
}

export interface PartyDialogProps {
  mode: 'create' | 'edit';
  party?: PartyDialogParty;
  /** Custom trigger; defaults to a "New party" / "Edit" button. */
  trigger?: React.ReactNode;
  /** Default type for create mode (e.g. from a "+ Financer" shortcut). */
  defaultType?: FinancePartyType;
  /** Called with the created party (create mode) after success. */
  onCreated?: (party: { id: string; name: string }) => void;
}

export function PartyDialog({
  mode,
  party,
  trigger,
  defaultType,
  onCreated,
}: PartyDialogProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: party?.name ?? '',
      type: party?.type ?? defaultType ?? FinancePartyType.VENDOR,
      phone: party?.phone ?? '',
      email: party?.email ?? '',
      notes: party?.notes ?? '',
      isActive: party?.isActive ?? true,
    },
  });

  const isSubmitting = form.formState.isSubmitting;

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) {
      form.reset({
        name: party?.name ?? '',
        type: party?.type ?? defaultType ?? FinancePartyType.VENDOR,
        phone: party?.phone ?? '',
        email: party?.email ?? '',
        notes: party?.notes ?? '',
        isActive: party?.isActive ?? true,
      });
    }
  };

  async function onSubmit(values: FormValues) {
    const payload: Record<string, unknown> =
      mode === 'create'
        ? {
            name: values.name,
            type: values.type,
            ...(values.phone !== '' ? { phone: values.phone } : {}),
            ...(values.email !== '' ? { email: values.email } : {}),
            ...(values.notes !== '' ? { notes: values.notes } : {}),
          }
        : {
            name: values.name,
            type: values.type,
            phone: values.phone === '' ? null : values.phone,
            email: values.email === '' ? null : values.email,
            notes: values.notes === '' ? null : values.notes,
            isActive: values.isActive,
          };

    const result =
      mode === 'create'
        ? await requestJson<{ id: string; name: string }>('/api/finance/parties', {
            method: 'POST',
            json: payload,
          })
        : await requestJson<{ id: string; name: string }>(
            `/api/finance/parties/${party?.id}`,
            { method: 'PATCH', json: payload },
          );

    if (!result.ok) {
      toast.error(result.message);
      return;
    }

    toast.success(mode === 'create' ? 'Party added.' : 'Party updated.');
    setOpen(false);
    if (mode === 'create') onCreated?.(result.data);
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
                <span>New party</span>
              </>
            ) : (
              'Edit'
            )}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{mode === 'create' ? 'New party' : 'Edit party'}</DialogTitle>
          <DialogDescription>
            A party is anyone money moves between us and: a financer, a card
            owner, a host who withdraws, a vendor, a client.
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            id="finance-party-form"
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
                      placeholder="Gadeshiya Rahulbhai"
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
                      {ALL_FINANCE_PARTY_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {FINANCE_PARTY_TYPE_LABELS[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormDescription>
                    Financers and card owners get a running &quot;we owe&quot; balance.
                  </FormDescription>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <FormField
                control={form.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      Phone <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
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
                    <FormLabel>
                      Email <span className="text-muted-foreground">(optional)</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="email"
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
              name="notes"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    Notes <span className="text-muted-foreground">(optional)</span>
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      rows={3}
                      maxLength={2000}
                      placeholder="Loan terms, card limit, UPI id…"
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
                        Inactive parties are hidden from the new-transaction picker.
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
          <Button type="submit" form="finance-party-form" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : mode === 'create' ? (
              'Add party'
            ) : (
              'Save changes'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
