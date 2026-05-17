'use client';

/**
 * Client-side credentials sign-in form for `/login`.
 *
 * Sits inside the Server Component `page.tsx` — the parent does the
 * "already signed in?" redirect, this component handles the
 * interactive submit + error states. Wired with:
 *
 *   • `react-hook-form` + `zod` for validation (SPEC §2, §13).
 *   • shadcn `Form` / `Input` / `Label` / `Button` primitives.
 *   • Auth.js v5's client-side `signIn('credentials', { redirect: false })`
 *     so we can capture the auth result and surface inline errors
 *     instead of letting NextAuth do its own redirect dance.
 *
 * Why `redirect: false`?
 *   - Default `signIn` redirects on both success and failure, which
 *     loses the error message and the loading state. Setting
 *     `redirect: false` returns `{ error, ok, status, url }` and lets
 *     us route via `router.push()` only on success.
 *
 * Failure modes handled:
 *   - Invalid credentials → inline `formError` ("Invalid email or
 *     password").
 *   - Network / unexpected error → same generic error so the form
 *     never reveals server internals (SPEC §13.5).
 *
 * The button shows a `Loader2` spinner and stays disabled while the
 * sign-in request is in flight (SPEC §13.4 loading states).
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { signIn } from 'next-auth/react';
import { Loader2 } from 'lucide-react';
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

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * Mirrors the server-side `credentialsSchema` in `@/lib/auth` so the
 * client rejects the same shapes the server would. Trim + lowercase the
 * email here too so what the user sees in the field matches what we
 * actually post.
 */
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, { message: 'Email is required' })
    .email({ message: 'Enter a valid email address' }),
  password: z.string().min(1, { message: 'Password is required' }),
});

type LoginValues = z.infer<typeof loginSchema>;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface LoginFormProps {
  /** Same-origin path to redirect to on success. Already sanitised by
   *  the parent server component. */
  callbackUrl: string;
}

export function LoginForm({ callbackUrl }: LoginFormProps) {
  const router = useRouter();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const isSubmitting = form.formState.isSubmitting;

  async function onSubmit(values: LoginValues) {
    setFormError(null);

    try {
      const result = await signIn('credentials', {
        email: values.email,
        password: values.password,
        redirect: false,
      });

      // Auth.js v5 returns `{ error: string | null, ok, status, url }`.
      // A non-null `error` means the credentials were rejected (or the
      // user is deactivated — same generic message either way per
      // SPEC §12.4 to avoid user enumeration).
      if (!result || result.error) {
        setFormError('Invalid email or password.');
        return;
      }

      // Success — full navigation so server components reload with the
      // freshly-issued session cookie. `router.push` would do a soft
      // nav and miss the new cookie until the next refresh.
      router.replace(callbackUrl);
      router.refresh();
    } catch {
      // Network blip / unexpected runtime error. Never echo internals.
      setFormError('Something went wrong. Please try again.');
    }
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
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input
                  type="email"
                  autoComplete="email"
                  placeholder="you@chitly.live"
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
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  autoComplete="current-password"
                  placeholder="••••••••"
                  disabled={isSubmitting}
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {formError ? (
          <p
            role="alert"
            aria-live="polite"
            className="text-sm font-medium text-destructive"
          >
            {formError}
          </p>
        ) : null}

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              <span>Signing in…</span>
            </>
          ) : (
            'Sign in'
          )}
        </Button>
      </form>
    </Form>
  );
}
