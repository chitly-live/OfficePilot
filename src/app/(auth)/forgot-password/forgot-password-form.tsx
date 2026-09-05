'use client';

/**
 * Email form for `/forgot-password`. Posts to
 * `POST /api/auth/forgot-password` and swaps to a "check your inbox"
 * panel on success. The success copy is the same whether or not the
 * account exists (the API is deliberately non-committal).
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, MailCheck } from 'lucide-react';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import { Input } from '@/components/ui/input';

const schema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, { message: 'Email is required' })
    .email({ message: 'Enter a valid email address' }),
});

type Values = z.infer<typeof schema>;

export function ForgotPasswordForm() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });
  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: Values) {
    setFormError(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: values.email }),
      });

      if (res.ok) {
        setSentTo(values.email);
        return;
      }

      let message = 'Something went wrong. Please try again.';
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string' && body.message.length > 0) {
          message = body.message;
        }
      } catch {
        // non-JSON error body — keep the generic message
      }
      setFormError(message);
    } catch {
      setFormError('Something went wrong. Please try again.');
    }
  }

  if (sentTo) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
          <MailCheck
            className="mt-0.5 h-5 w-5 shrink-0 text-status-green"
            aria-hidden="true"
          />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Check your email</p>
            <p className="text-muted-foreground">
              If an account exists for <span className="font-medium">{sentTo}</span>,
              a reset link is on its way. It works once and expires in 30 minutes.
              Check spam if it doesn&apos;t show up in a minute.
            </p>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          className="w-full"
          onClick={() => {
            setSentTo(null);
            form.reset({ email: sentTo });
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@chitly.live"
                  autoFocus
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {formError ? (
          <p role="alert" aria-live="polite" className="text-sm font-medium text-destructive">
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Sending link…</span>
            </>
          ) : (
            'Send reset link'
          )}
        </Button>
      </form>
    </Form>
  );
}
