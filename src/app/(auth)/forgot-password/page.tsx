/**
 * `/forgot-password` — ask for a password reset link by email.
 *
 * Public page (whitelisted in `src/middleware.ts`). A visitor who is
 * already signed in is sent to the dashboard instead — they can change
 * their password from their profile.
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { auth } from '@/lib/auth';

import { AuthWordmark } from '../auth-wordmark';
import { ForgotPasswordForm } from './forgot-password-form';

export const metadata = {
  title: 'Forgot password · OfficePilot',
};

export const dynamic = 'force-dynamic';

export default async function ForgotPasswordPage() {
  const session = await auth();
  if (session?.userId) {
    redirect('/dashboard');
  }

  return (
    <div className="flex flex-col items-center gap-8">
      <AuthWordmark />

      <Card className="w-full">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">Forgot your password?</CardTitle>
          <p className="text-sm text-muted-foreground">
            Enter the email you sign in with. We&apos;ll send a link to choose a
            new password.
          </p>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        Remembered it?{' '}
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </div>
  );
}
