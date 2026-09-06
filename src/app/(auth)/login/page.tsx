/**
 * `/login` — Credentials sign-in page.
 *
 * Server Component responsibilities (per SPEC §2.2 and design.md
 * "Roles, Auth, and Permissions"):
 *
 *   1. If a valid session cookie is already present, bounce the user
 *      straight to `/dashboard` (or to `?callbackUrl=` if it's a safe
 *      same-origin path). Avoids the "log in twice" UX where a logged-in
 *      user lands on `/login` from a stale tab.
 *   2. Render the branded shell (Chitly / OfficePilot wordmark) inside a
 *      shadcn `Card`. Form interaction lives in `LoginForm`, the
 *      sibling client component — keeps this file free of `'use client'`
 *      so the auth redirect runs on the server.
 *
 * Note: `auth()` from `@/lib/auth` is the Node-runtime helper backed by
 * the full Auth.js config (Prisma + bcrypt). Safe to call here because
 * pages render under the Node runtime by default.
 */

import { redirect } from 'next/navigation';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { auth } from '@/lib/auth';

import { LoginForm } from './login-form';

// Always render fresh — session state is request-specific and the
// redirect decision must reflect the current cookie, not a build-time
// snapshot.
export const dynamic = 'force-dynamic';

interface LoginPageProps {
  // Next.js 14 passes route params + searchParams as props to page.tsx.
  searchParams?: { callbackUrl?: string | string[] };
}

/**
 * Sanitise the `callbackUrl` query param.
 *
 * NextAuth's own redirect handling already refuses cross-origin URLs,
 * but we re-enforce the constraint here so a forged `?callbackUrl=`
 * can never bounce an already-authenticated visitor off-site. Only
 * same-origin paths starting with `/` (and not `//` protocol-relative)
 * are honoured; anything else falls back to `/dashboard`.
 */
function resolveCallbackUrl(raw: string | string[] | undefined): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (
    typeof candidate === 'string' &&
    candidate.startsWith('/') &&
    !candidate.startsWith('//')
  ) {
    return candidate;
  }
  return '/dashboard';
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const session = await auth();
  const callbackUrl = resolveCallbackUrl(searchParams?.callbackUrl);

  // Already signed in → skip the form entirely.
  if (session?.userId) {
    redirect(callbackUrl);
  }

  return (
    <div className="flex flex-col items-center gap-8">
      {/* Brand wordmark — SPEC §13.1 indigo accent. Plain text keeps
          this lightweight (no logo asset wired yet); the brand colour
          and tracking carry the identity. */}
      <div className="flex flex-col items-center gap-1 text-center">
        <span
          className="
            text-3xl font-semibold tracking-tight text-foreground
          "
        >
          Office<span className="text-brand-600">Pilot</span>
        </span>
        <span className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
          by Praxxel
        </span>
      </div>

      <Card className="w-full">
        <CardHeader className="space-y-1">
          <CardTitle className="text-xl">Sign in</CardTitle>
          <p className="text-sm text-muted-foreground">
            Enter your email and password to access your workspace.
          </p>
        </CardHeader>
        <CardContent>
          <LoginForm callbackUrl={callbackUrl} />
        </CardContent>
      </Card>
    </div>
  );
}
