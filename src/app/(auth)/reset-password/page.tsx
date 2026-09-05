/**
 * `/reset-password?token=…` — choose a new password from an emailed link.
 *
 * Public page. The token is checked server-side before the form renders
 * so an expired / used link shows a clear message with a way to request
 * a fresh one instead of failing on submit.
 */

import Link from 'next/link';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { prisma } from '@/lib/db';
import {
  RESET_TOKEN_MAX_LENGTH,
  RESET_TOKEN_MIN_LENGTH,
} from '@/lib/password-reset';
import { findUsableResetToken } from '@/lib/password-reset-service';

import { AuthWordmark } from '../auth-wordmark';
import { ResetPasswordForm } from './reset-password-form';

export const metadata = {
  title: 'Reset password · OfficePilot',
};

export const dynamic = 'force-dynamic';

interface ResetPasswordPageProps {
  searchParams?: { token?: string | string[] };
}

function readToken(raw: string | string[] | undefined): string | null {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (
    trimmed.length < RESET_TOKEN_MIN_LENGTH ||
    trimmed.length > RESET_TOKEN_MAX_LENGTH
  ) {
    return null;
  }
  return trimmed;
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const token = readToken(searchParams?.token);
  const usable = token ? await findUsableResetToken(prisma, token) : null;

  return (
    <div className="flex flex-col items-center gap-8">
      <AuthWordmark />

      {usable && token ? (
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl">Choose a new password</CardTitle>
            <p className="text-sm text-muted-foreground">
              At least 8 characters. You&apos;ll be signed out everywhere else.
            </p>
          </CardHeader>
          <CardContent>
            <ResetPasswordForm token={token} />
          </CardContent>
        </Card>
      ) : (
        <Card className="w-full">
          <CardHeader className="space-y-1">
            <CardTitle className="text-xl">This link has expired</CardTitle>
            <p className="text-sm text-muted-foreground">
              Reset links work once and only for 30 minutes. Request a new one
              and use the latest email.
            </p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Button asChild className="w-full">
              <Link href="/forgot-password">Request a new link</Link>
            </Button>
            <Button asChild variant="ghost" className="w-full">
              <Link href="/login">Back to sign in</Link>
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
