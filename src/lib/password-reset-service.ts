/**
 * Self-service password reset — database + email side.
 *
 * Pure helpers (tokens, URLs, email bodies) live in `password-reset.ts`;
 * this module owns the two operations the API routes call:
 *
 *   • {@link requestPasswordReset}  — "forgot password" submit
 *   • {@link completePasswordReset} — "set new password" submit
 *
 * plus {@link findUsableResetToken}, which the `/reset-password` page uses
 * to decide whether to show the form or an "expired link" message.
 *
 * Covered by `tests/integration/auth.password-reset.test.ts` with the
 * mailer mocked at the module boundary.
 */

import { hash as bcryptHash } from 'bcryptjs';
import type { PrismaClient } from '@prisma/client';

import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { sendMail } from '@/lib/mailer';
import {
  PASSWORD_RESET_MAX_PER_HOUR,
  buildResetEmail,
  buildResetUrl,
  generateResetToken,
  hashResetToken,
  isResetTokenUsable,
  resetTokenExpiry,
} from '@/lib/password-reset';

/** Same cost as `POST /api/users` so all hashes verify at the same speed. */
const BCRYPT_COST = 12;
const ONE_HOUR_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The token is unknown, already used, expired, or its user is inactive. */
export class InvalidResetTokenError extends Error {
  constructor() {
    super('This reset link is invalid or has expired.');
    this.name = 'InvalidResetTokenError';
  }
}

// ---------------------------------------------------------------------------
// Request a link
// ---------------------------------------------------------------------------

export type RequestResetOutcome =
  | 'sent'
  | 'no_user'
  | 'inactive'
  | 'rate_limited'
  | 'mail_failed';

export interface RequestPasswordResetInput {
  /** Already trimmed + lower-cased by the zod schema. */
  email: string;
  /** Origin for the emailed link, e.g. `https://officepilot.chitly.live`. */
  baseUrl: string;
  requestIp?: string | null;
  now?: Date;
}

/**
 * Create a single-use token for the account (if it exists and is active),
 * email the link, audit the request. Callers should answer the same way
 * regardless of the outcome — the outcome is for logging only.
 */
export async function requestPasswordReset(
  db: PrismaClient,
  input: RequestPasswordResetInput,
): Promise<{ outcome: RequestResetOutcome }> {
  const now = input.now ?? new Date();

  const user = await db.user.findUnique({
    where: { email: input.email },
    select: { id: true, email: true, name: true, isActive: true },
  });
  if (!user) return { outcome: 'no_user' };
  if (!user.isActive) return { outcome: 'inactive' };

  const recent = await db.passwordResetToken.count({
    where: {
      userId: user.id,
      createdAt: { gte: new Date(now.getTime() - ONE_HOUR_MS) },
    },
  });
  if (recent >= PASSWORD_RESET_MAX_PER_HOUR) return { outcome: 'rate_limited' };

  const { raw, hash } = generateResetToken();

  // Only the newest link works — older unused ones are retired.
  await db.passwordResetToken.updateMany({
    where: { userId: user.id, usedAt: null },
    data: { usedAt: now },
  });
  const row = await db.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hash,
      expiresAt: resetTokenExpiry(now),
      requestIp: input.requestIp ?? null,
    },
    select: { id: true },
  });

  const email = buildResetEmail({
    name: user.name,
    resetUrl: buildResetUrl(input.baseUrl, raw),
  });

  try {
    await sendMail({ to: user.email, ...email });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[password-reset] failed to send reset email', err);
    // Nothing reached the user, so the token is dead weight — and it
    // should not count against their hourly allowance.
    await db.passwordResetToken
      .delete({ where: { id: row.id } })
      .catch(() => undefined);
    return { outcome: 'mail_failed' };
  }

  try {
    await logActivity(db, {
      userId: user.id,
      action: ACTIVITY_ACTIONS.USER_PASSWORD_RESET_REQUESTED,
      entityType: 'user',
      entityId: user.id,
      metadata: {
        userName: user.name,
        entityName: user.name,
        requestIp: input.requestIp ?? null,
      },
    });
  } catch (logErr) {
    // eslint-disable-next-line no-console
    console.error('[password-reset] failed to log reset request', logErr);
  }

  return { outcome: 'sent' };
}

// ---------------------------------------------------------------------------
// Validate / consume a token
// ---------------------------------------------------------------------------

/**
 * Look a raw token up. Returns the row's id + owner when it is unused,
 * unexpired and belongs to an active user; otherwise `null`.
 */
export async function findUsableResetToken(
  db: PrismaClient,
  rawToken: string,
  now: Date = new Date(),
): Promise<{ id: string; userId: string } | null> {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: hashResetToken(rawToken) },
    select: {
      id: true,
      userId: true,
      expiresAt: true,
      usedAt: true,
      user: { select: { isActive: true } },
    },
  });
  if (!row || !row.user.isActive || !isResetTokenUsable(row, now)) return null;
  return { id: row.id, userId: row.userId };
}

export interface CompletePasswordResetInput {
  token: string;
  /** Already validated against the password policy by the zod schema. */
  password: string;
  now?: Date;
}

/**
 * Set a new password from a valid token. Marks the token (and any other
 * outstanding tokens for the user) used, stamps `passwordChangedAt`, and
 * audits the change. Throws {@link InvalidResetTokenError} when the token
 * cannot be used — including when two submits race for the same token.
 */
export async function completePasswordReset(
  db: PrismaClient,
  input: CompletePasswordResetInput,
): Promise<{ userId: string; email: string }> {
  const now = input.now ?? new Date();
  const usable = await findUsableResetToken(db, input.token, now);
  if (!usable) throw new InvalidResetTokenError();

  const passwordHash = await bcryptHash(input.password, BCRYPT_COST);

  const user = await db.$transaction(async (tx) => {
    // Consume the token atomically: the `usedAt: null` guard means a
    // concurrent second submit sees `count === 0` and fails cleanly.
    const consumed = await tx.passwordResetToken.updateMany({
      where: { id: usable.id, usedAt: null },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw new InvalidResetTokenError();

    await tx.passwordResetToken.updateMany({
      where: { userId: usable.userId, usedAt: null },
      data: { usedAt: now },
    });

    return tx.user.update({
      where: { id: usable.userId },
      data: { passwordHash, passwordChangedAt: now },
      select: { id: true, email: true, name: true },
    });
  });

  try {
    await logActivity(db, {
      userId: user.id,
      action: ACTIVITY_ACTIONS.USER_PASSWORD_RESET_COMPLETED,
      entityType: 'user',
      entityId: user.id,
      metadata: { userName: user.name, entityName: user.name },
    });
  } catch (logErr) {
    // eslint-disable-next-line no-console
    console.error('[password-reset] failed to log reset completion', logErr);
  }

  return { userId: user.id, email: user.email };
}
