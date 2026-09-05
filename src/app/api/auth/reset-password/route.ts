/**
 * `POST /api/auth/reset-password` — finish a self-service password reset.
 *
 * Body: `{ token, password }`. Public route (see `src/middleware.ts`).
 * 400 for a token that is unknown / used / expired or a password that
 * fails the policy; 200 `{ ok: true }` on success. The user then signs
 * in normally — no session is created here.
 */

import { NextResponse, type NextRequest } from 'next/server';

import {
  BadRequestError,
  errorResponse,
  parseJsonBody,
} from '@/lib/api-helpers';
import { prisma } from '@/lib/db';
import {
  InvalidResetTokenError,
  completePasswordReset,
} from '@/lib/password-reset-service';
import { resetPasswordSchema } from '@/lib/schemas/password-reset';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const input = await parseJsonBody(req, resetPasswordSchema);

    try {
      await completePasswordReset(prisma, {
        token: input.token,
        password: input.password,
      });
    } catch (err) {
      if (err instanceof InvalidResetTokenError) {
        throw new BadRequestError(
          'This reset link is invalid or has expired. Request a new one.',
        );
      }
      throw err;
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
