'use client';

/**
 * New-password form for `/reset-password`. Posts `{ token, password }` to
 * `POST /api/auth/reset-password`; on success shows a confirmation with a
 * sign-in button (no session is created by the reset itself).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Loader2 } from 'lucide-react';
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

const MIN_PASSWORD_LENGTH = 8;

const schema = z
  .object({
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, {
        message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      })
      .max(200, { message: 'Password must be 200 characters or fewer' }),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'Passwords do not match',
    path: ['confirm'],
  });

type Values = z.infer<typeof schema>;

interface ResetPasswordFormProps {
  token: string;
}

export function ResetPasswordForm({ token }: ResetPasswordFormProps) {
  const [done, setDone] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [linkDead, setLinkDead] = useState(false);

  const form = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });
  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: Values) {
    setFormError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, password: values.password }),
      });

      if (res.ok) {
        setDone(true);
        return;
      }

      let message = 'Something went wrong. Please try again.';
      try {
        const body = (await res.json()) as { message?: unknown };
        if (typeof body.message === 'string' && body.message.length > 0) {
          message = body.message;
        }
      } catch {
        // keep generic
      }
      if (res.status === 400 && /invalid or has expired/i.test(message)) {
        setLinkDead(true);
      }
      setFormError(message);
    } catch {
      setFormError('Something went wrong. Please try again.');
    }
  }

  if (done) {
    return (
      <div className="space-y-4" role="status" aria-live="polite">
        <div className="flex items-start gap-3 rounded-md border bg-muted/30 p-4">
          <CheckCircle2
            className="mt-0.5 h-5 w-5 shrink-0 text-status-green"
            aria-hidden="true"
          />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">Password updated</p>
            <p className="text-muted-foreground">
              Sign in with your new password. Any other devices have been signed out.
            </p>
          </div>
        </div>
        <Button asChild className="w-full">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>New password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  autoFocus
                  disabled={isSubmitting || linkDead}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        <FormField
          control={form.control}
          name="confirm"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Confirm new password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  disabled={isSubmitting || linkDead}
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

        {linkDead ? (
          <Button asChild variant="outline" className="w-full">
            <Link href="/forgot-password">Request a new link</Link>
          </Button>
        ) : (
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                <span>Saving…</span>
              </>
            ) : (
              'Set new password'
            )}
          </Button>
        )}
      </form>
    </Form>
  );
}
