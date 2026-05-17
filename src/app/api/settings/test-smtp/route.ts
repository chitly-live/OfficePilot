/**
 * `POST /api/settings/test-smtp` — admin-only "Send test email" button
 * behind the Settings → Email (SMTP) section.
 *
 * Reads the currently-resolved SMTP config (Setting rows take
 * precedence over env vars; see {@link resolveSmtpConfig}) and tries to
 * send a single short message so the admin can verify their credentials
 * before relying on the mailer for cron digests, account emails, etc.
 *
 * Request:
 *
 *   POST /api/settings/test-smtp
 *   Authorization: cookie (admin session)
 *   { "to"?: string }
 *
 *   If `to` is omitted, we default to the admin's own `User.email` so
 *   the round-trip lands in their inbox without typing the address.
 *
 * Responses:
 *
 *   200 — { ok: true, sentTo: 'admin@example.com' }
 *         The transport accepted the message; the SMTP server returned
 *         success. (Final delivery is the recipient's problem.)
 *
 *   400 — { error: 'smtp_not_configured' }
 *         `resolveSmtpConfig()` returned `null` — at least one of
 *         host / port / user / pass / from is missing from both the
 *         Setting table and the env vars.
 *
 *   400 — { error: 'invalid_recipient' }
 *         No `to` was supplied AND the admin's account has no email on
 *         file. (Their account row was created by another admin without
 *         an email value — rare but possible.)
 *
 *   401 / 403 — standard `requireAdminSession` failure modes.
 *
 *   502 — { error: 'smtp_send_failed', message: <safe-message> }
 *         Nodemailer threw (auth error, network unreachable, server
 *         rejected the recipient, etc.). The plaintext SMTP password
 *         is NEVER included in the response — we scrub the error
 *         message defensively before returning.
 *
 * Activity log: every attempt — successful or not — writes a
 * `settings.smtp_test_sent` row so the admin's audit trail records who
 * pinged whom. Metadata: `{ to, ok }`.
 *
 * Side-effects: at most one outbound SMTP message per request.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { prisma } from '@/lib/db';
import {
  BadRequestError,
  errorResponse,
  requireAdminSession,
} from '@/lib/api-helpers';
import { ACTIVITY_ACTIONS, logActivity } from '@/lib/activity';
import { resolveSmtpConfig, sendMail } from '@/lib/mailer';

// nodemailer + Prisma + node:crypto are not Edge-compatible.
export const runtime = 'nodejs';

// Each request is a fresh send — never cache the response.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Body schema
// ---------------------------------------------------------------------------

/**
 * Request body schema. Both fields are optional — the handler defaults
 * `to` to the caller's own email. The relaxed "looks like an email"
 * regex matches the {@link smtp_from} validator; nodemailer will reject
 * malformed addresses at send time with a clearer message than we
 * could produce here.
 *
 * Empty body (`{}`) is accepted — `parseJsonBody` requires JSON but
 * the schema tolerates an empty object.
 */
const testSmtpBodySchema = z
  .object({
    to: z
      .string()
      .trim()
      .min(1, 'Recipient cannot be empty')
      .max(320, 'Recipient address is too long')
      .refine(
        (s) => /^.+@.+\..+$/.test(s) || /^.+<.+@.+\..+>$/.test(s),
        '`to` must be an email address',
      )
      .optional(),
  })
  // Treat the empty body the same as `{}` so a no-body POST works.
  .default({});

/**
 * Custom JSON parser tolerant of empty bodies. `parseJsonBody`
 * (`@/lib/api-helpers`) calls `req.json()` and 400s on `SyntaxError`;
 * that's correct for routes that require a body, but here the body is
 * genuinely optional. We try `req.text()` first, and apply the
 * schema's `.default({})` whenever the body is empty or unparseable
 * whitespace.
 *
 * Reading via `.text()` instead of `.json()` keeps us out of the
 * "empty body throws SyntaxError" trap that `parseJsonBody` would hit
 * for a no-body POST, while still surfacing real JSON parse failures
 * as 400s for non-empty bodies.
 */
async function readOptionalBody(
  req: NextRequest,
): Promise<{ to?: string }> {
  let raw = '';
  try {
    raw = await req.text();
  } catch {
    raw = '';
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return testSmtpBodySchema.parse(undefined);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new BadRequestError('Invalid JSON body');
  }
  const result = testSmtpBodySchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError('Validation failed', result.error);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scrub anything that looks like the SMTP password out of an error
 * message so an unhandled nodemailer throw can never leak the
 * credential back to the client.
 *
 * `pass` may appear unquoted in low-level error strings (e.g. when an
 * upstream library logs the raw auth payload). We do a literal
 * substring replace — paranoid but cheap — and also strip anything
 * structured-looking like `password=...` or `pass: "..."`.
 */
function safeErrorMessage(err: unknown, pass: string): string {
  const raw =
    err instanceof Error && typeof err.message === 'string'
      ? err.message
      : 'SMTP send failed';
  // Trim absurdly long messages — node's TLS errors can be paragraphs.
  const truncated = raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
  if (pass.length === 0) return truncated;
  // Replace exact occurrences of the secret.
  return truncated.split(pass).join('***');
}

/**
 * Build the (very short) HTML + text body of the test message.
 * `<timestamp>` is the ISO8601 string at send time so the admin can
 * tell at a glance which test produced which inbox row.
 */
function buildTestEmailBody(timestamp: string): { html: string; text: string } {
  const html = [
    '<p>This is a test email from OfficePilot.</p>',
    `<p>SMTP transport verified at <code>${timestamp}</code>.</p>`,
    '<p>If you received this, your Settings → Email (SMTP) configuration is working.</p>',
  ].join('');
  const text = [
    'This is a test email from OfficePilot.',
    '',
    `SMTP transport verified at ${timestamp}.`,
    '',
    'If you received this, your Settings → Email (SMTP) configuration is working.',
  ].join('\n');
  return { html, text };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const session = await requireAdminSession();
    const body = await readOptionalBody(req);

    // ---------------------------------------------------------------
    // Resolve target recipient. Falls back to the admin's own email
    // when the client omits `to`.
    // ---------------------------------------------------------------
    let recipient = body.to ?? '';
    if (recipient.length === 0) {
      const admin = await prisma.user.findUnique({
        where: { id: session.userId },
        select: { email: true },
      });
      recipient = admin?.email ?? '';
    }
    if (recipient.length === 0) {
      return NextResponse.json(
        { error: 'invalid_recipient' },
        { status: 400 },
      );
    }

    // ---------------------------------------------------------------
    // Resolve the SMTP config up-front so we can:
    //   • return 400 cleanly when the mailer is disabled, and
    //   • know the plaintext password for the leak-scrubber below.
    // ---------------------------------------------------------------
    const cfg = await resolveSmtpConfig();
    if (cfg === null) {
      return NextResponse.json(
        { error: 'smtp_not_configured' },
        { status: 400 },
      );
    }

    // ---------------------------------------------------------------
    // Send.
    // ---------------------------------------------------------------
    const timestamp = new Date().toISOString();
    const { html, text } = buildTestEmailBody(timestamp);

    try {
      await sendMail({
        to: recipient,
        subject: `OfficePilot SMTP test — configured at ${timestamp}`,
        html,
        text,
      });
    } catch (sendErr) {
      const message = safeErrorMessage(sendErr, cfg.pass);
      // eslint-disable-next-line no-console
      console.error('[api/settings/test-smtp] send failed', { recipient });

      // Best-effort audit row — log the attempt as failed so the
      // admin's timeline shows it. The action falls into the
      // `ActivityEvent` fallback variant (no bespoke metadata schema)
      // so the `{ to, ok }` payload rides on the generic
      // `Record<string, unknown>` slot.
      try {
        await logActivity(prisma, {
          userId: session.userId,
          action: ACTIVITY_ACTIONS.SETTINGS_SMTP_TEST_SENT,
          entityType: 'setting',
          entityId: 'smtp',
          metadata: { to: recipient, ok: false },
        });
      } catch (logErr) {
        // eslint-disable-next-line no-console
        console.error('[api/settings/test-smtp] activity log failed', logErr);
      }

      return NextResponse.json(
        { error: 'smtp_send_failed', message },
        { status: 502 },
      );
    }

    // ---------------------------------------------------------------
    // Success path — log + 200.
    // ---------------------------------------------------------------
    try {
      await logActivity(prisma, {
        userId: session.userId,
        action: 'settings.smtp_test_sent' as never,
        entityType: 'setting',
        entityId: 'smtp',
        metadata: { to: recipient, ok: true },
      });
    } catch (logErr) {
      // eslint-disable-next-line no-console
      console.error('[api/settings/test-smtp] activity log failed', logErr);
    }

    return NextResponse.json({ ok: true, sentTo: recipient });
  } catch (err) {
    return errorResponse(err);
  }
}
