/**
 * Self-service password reset — pure helpers (no I/O).
 *
 * Flow (see `password-reset-service.ts` for the DB / mail side):
 *
 *   1. `/forgot-password` → `POST /api/auth/forgot-password { email }`.
 *      Always answers 200 so the form can't be used to enumerate accounts.
 *   2. If the account exists and is active, a random 32-byte token is
 *      generated. Only its SHA-256 goes into `PasswordResetToken`; the raw
 *      token goes into the emailed link `/reset-password?token=…`.
 *   3. `/reset-password` → `POST /api/auth/reset-password { token, password }`
 *      hashes the token, checks expiry / single-use / active user, writes
 *      the new bcrypt hash and stamps `User.passwordChangedAt` so other
 *      sessions are dropped on their next re-check (`src/lib/auth.ts`).
 *
 * Unit-tested in `password-reset.test.ts`.
 */

import { createHash, randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** A reset link stays valid for this long. */
export const PASSWORD_RESET_TTL_MINUTES = 30;
export const PASSWORD_RESET_TTL_MS = PASSWORD_RESET_TTL_MINUTES * 60 * 1000;

/** Max links one account can request per rolling hour. */
export const PASSWORD_RESET_MAX_PER_HOUR = 3;

/** Raw token entropy. 32 bytes → 43-char base64url string. */
export const RESET_TOKEN_BYTES = 32;

/** Bounds the API accepts for the raw token (base64url, 43 chars today). */
export const RESET_TOKEN_MIN_LENGTH = 20;
export const RESET_TOKEN_MAX_LENGTH = 200;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/** SHA-256 hex of the raw token — the only form that is ever persisted. */
export function hashResetToken(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/** A fresh random token plus the hash to store. */
export function generateResetToken(): { raw: string; hash: string } {
  const raw = randomBytes(RESET_TOKEN_BYTES).toString('base64url');
  return { raw, hash: hashResetToken(raw) };
}

/** `now + TTL`. */
export function resetTokenExpiry(now: Date = new Date()): Date {
  return new Date(now.getTime() + PASSWORD_RESET_TTL_MS);
}

/** Unused and not yet expired (expiry instant itself counts as expired). */
export function isResetTokenUsable(
  row: { expiresAt: Date; usedAt: Date | null },
  now: Date = new Date(),
): boolean {
  return row.usedAt === null && row.expiresAt.getTime() > now.getTime();
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/**
 * Trim, drop trailing slashes, require an http(s) origin. Anything else
 * (empty, `localhost:3000` without a scheme, garbage) → `null`.
 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) return null;
  return trimmed;
}

/**
 * Where reset links should point. `NEXTAUTH_URL` wins (set in prod and in
 * `.env.example`), then `AUTH_URL`, then the request origin the caller
 * passes in, then the dev default.
 */
export function resolveAppBaseUrl(fallbackOrigin?: string | null): string {
  return (
    normalizeBaseUrl(process.env.NEXTAUTH_URL) ??
    normalizeBaseUrl(process.env.AUTH_URL) ??
    normalizeBaseUrl(fallbackOrigin) ??
    'http://localhost:3000'
  );
}

/** `${base}/reset-password?token=<url-encoded raw token>`. */
export function buildResetUrl(baseUrl: string, rawToken: string): string {
  const base = normalizeBaseUrl(baseUrl) ?? baseUrl.replace(/\/+$/, '');
  return `${base}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escape user-controlled text before interpolating it into HTML. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

export interface ResetEmailInput {
  /** Recipient's display name (escaped for the HTML body). */
  name: string;
  resetUrl: string;
  ttlMinutes?: number;
}

export interface ResetEmail {
  subject: string;
  html: string;
  text: string;
}

/** Subject + HTML + plain-text bodies for the reset email. */
export function buildResetEmail(input: ResetEmailInput): ResetEmail {
  const ttl = input.ttlMinutes ?? PASSWORD_RESET_TTL_MINUTES;
  const safeName = escapeHtml(input.name.trim() || 'there');
  const safeUrl = escapeHtml(input.resetUrl);

  const subject = 'Reset your OfficePilot password';

  const html = [
    `<p>Hi ${safeName},</p>`,
    '<p>Someone (hopefully you) asked to reset the password for your OfficePilot account.</p>',
    `<p><a href="${safeUrl}" style="display:inline-block;padding:10px 18px;background:#6366f1;color:#ffffff;text-decoration:none;border-radius:6px;font-weight:600">Choose a new password</a></p>`,
    `<p>Or paste this link into your browser:<br><a href="${safeUrl}">${safeUrl}</a></p>`,
    `<p>This link works once and expires in ${ttl} minutes.</p>`,
    '<p>If you did not ask for this, ignore this email — your password stays the same.</p>',
    '<p style="color:#6b7280;font-size:12px">OfficePilot · Chitly</p>',
  ].join('');

  const text = [
    `Hi ${input.name.trim() || 'there'},`,
    '',
    'Someone (hopefully you) asked to reset the password for your OfficePilot account.',
    '',
    'Choose a new password here:',
    input.resetUrl,
    '',
    `This link works once and expires in ${ttl} minutes.`,
    'If you did not ask for this, ignore this email — your password stays the same.',
    '',
    'OfficePilot · Chitly',
  ].join('\n');

  return { subject, html, text };
}
