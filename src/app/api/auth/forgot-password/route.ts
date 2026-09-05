/**
 * `POST /api/auth/forgot-password` — start a self-service password reset.
 *
 * Public (the `/api/auth` prefix is whitelisted in `src/middleware.ts`;
 * this static route wins over Auth.js's `[...nextauth]` catch-all).
 *
 * Always answers 200 with the same message whether or not the email
 * belongs to an account, so the form cannot be used to enumerate users.
 * The one exception is a broken mailer (503) — on an internal tool a
 * silent failure would just strand the person.
 */

import { NextResponse, type NextRequest } from 'next/server';

import { errorResponse, parseJsonBody } from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import { resolveAppBaseUrl } from '@/lib/password-reset';
import { requestPasswordReset } from '@/lib/password-reset-service';
import { forgotPasswordSchema } from '@/lib/schemas/password-reset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GENERIC_MESSAGE =
  'If an account exists for that email, a reset link is on its way.';

function clientIp(req: NextRequest): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  const real = req.headers.get('x-real-ip');
  return real ? real.trim().slice(0, 64) : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const input = await parseJsonBody(req, forgotPasswordSchema);

    const { outcome } = await requestPasswordReset(prisma, {
      email: input.email,
      baseUrl: resolveAppBaseUrl(req.nextUrl.origin),
      requestIp: clientIp(req),
    });

    if (outcome === 'mail_failed') {
      return NextResponse.json(
        {
          error: 'mail_unavailable',
          message:
            'We could not send the email right now. Ask an admin to reset your password.',
        },
        { status: 503 },
      );
    }

    if (outcome === 'rate_limited' || outcome === 'inactive') {
      // eslint-disable-next-line no-console
      console.warn(`[forgot-password] link not sent (${outcome})`);
    }

    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE });
  } catch (err) {
    return errorResponse(err);
  }
}
