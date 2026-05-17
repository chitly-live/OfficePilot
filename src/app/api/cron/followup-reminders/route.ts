/**
 * `POST /api/cron/followup-reminders` — bearer-token-protected cron
 * endpoint that emails each lead owner a digest of follow-ups that are
 * due today or overdue.
 *
 * SPEC.md §6.2 #5 ("Follow-up reminders: dashboard alerts + optional
 * email") and §11.1 row 4 ("Follow-up reminders" widget on the
 * dashboard). Routing/scheduling notes live in SPEC.md §10.6 — both
 * cron endpoints share the same `Authorization: Bearer ${CRON_SECRET}`
 * convention so a single PM2 worker / system crontab can drive them.
 *
 * **Public endpoint, bearer-gated.** The middleware
 * (`src/middleware.ts`) explicitly excludes `/api/cron/*` from
 * cookie-based auth so a system cron call without a session can reach
 * us. The bearer check below is therefore the entire authorization
 * story — getting it wrong means anyone on the public internet can
 * make us flood owners' inboxes. We use {@link crypto.timingSafeEqual}
 * to compare the supplied token against `CRON_SECRET` so an attacker
 * cannot inch toward the right value byte-by-byte from response timing.
 *
 * **What it does.**
 *
 *   1. Resolve all leads whose `nextFollowUpAt <= now()` and whose
 *      status is not `CONVERTED`/`LOST`. This intentionally covers
 *      both "due today" and "overdue" — a missed reminder shouldn't
 *      silently fall off the next morning's digest.
 *   2. Group the leads by `owner.email`. Leads with no owner, or with
 *      an owner that has no email on file, are skipped (recorded in
 *      `errors[]` so an admin can fix the data).
 *   3. For each owner with at least one due lead, send a single
 *      digest email summarising the leads. Per-owner failures are
 *      logged and added to `errors[]`; one bad recipient does NOT
 *      tank the rest of the digest.
 *   4. Return `{ ok, ownersNotified, leadsCovered, errors }` so the
 *      scheduler can record success/failure metrics.
 *
 * **What it does NOT do.** This endpoint never updates
 * `Lead.nextFollowUpAt`. The email is a reminder; clearing the
 * follow-up is a deliberate action by the rep (mark the lead actioned
 * in `/leads/[id]` or set a new `nextFollowUpAt`). Auto-clearing
 * would silently swallow overdue work.
 */

import crypto from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { prisma } from '@/lib/db';
import { errorResponse } from '@/lib/api-helpers';
import { sendMail } from '@/lib/mailer';

// Force the Node runtime — Prisma + node:crypto + nodemailer are not
// Edge-compatible.
export const runtime = 'nodejs';

// Each request must execute live against the DB / mailer.
export const dynamic = 'force-dynamic';

// ---------------------------------------------------------------------------
// Bearer token helpers
// ---------------------------------------------------------------------------

/**
 * Extract the bearer token from an `Authorization` header.
 *
 *   "Bearer abc123"  → "abc123"
 *   "bearer abc123"  → "abc123"
 *   anything else    → null
 *
 * Whitespace is trimmed; the scheme prefix is matched case-insensitively
 * (`Authorization: bearer ...` is legal per RFC 7235 even though the
 * canonical case is `Bearer`).
 */
function extractBearerToken(rawHeader: string | null): string | null {
  if (rawHeader === null) return null;
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) return null;
  const spaceIdx = trimmed.indexOf(' ');
  if (spaceIdx < 0) return null;
  const scheme = trimmed.slice(0, spaceIdx).toLowerCase();
  if (scheme !== 'bearer') return null;
  const token = trimmed.slice(spaceIdx + 1).trim();
  return token.length > 0 ? token : null;
}

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` requires equal-length buffers; an unequal length
 * is itself "trivially wrong" with no secret to leak by short-circuiting,
 * so we early-return `false` and skip the syscall.
 */
function safeStringEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

// ---------------------------------------------------------------------------
// Email rendering
// ---------------------------------------------------------------------------

/**
 * One lead row used to build the digest email. Pulled from Prisma in
 * `findMany`; `owner` is included so we can group + greet by name.
 */
interface DueLead {
  id: string;
  name: string;
  company: string | null;
  nextFollowUpAt: Date | null;
  owner: { id: string; name: string; email: string } | null;
}

/**
 * Format a `Date` as the human-readable date used in the digest body.
 * Locale-stable: we always render `YYYY-MM-DD` so a digest emailed to
 * an owner in any timezone reads the same. The full timestamp would
 * be noise for a daily reminder.
 */
function formatFollowUpDate(d: Date | null): string {
  if (d === null) return 'today';
  // toISOString() always returns a UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; we
  // slice off the date portion for a stable, locale-free rendering.
  return d.toISOString().slice(0, 10);
}

/**
 * HTML-escape a string for safe interpolation into the digest body.
 *
 * Lead names, company names, and owner names are user-controlled so
 * they MUST be escaped before they end up in an HTML attribute or
 * text node. Only the five characters that have special meaning in
 * HTML need to be encoded.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build the HTML body of a digest for one owner.
 *
 * Each lead becomes a list item: `Lead name (Company) — Follow up by
 * 2024-01-31`. When `NEXTAUTH_URL` is set the lead name links to
 * `${NEXTAUTH_URL}/leads/${id}` so the rep can jump straight to the
 * detail page; otherwise it falls back to bare text. We never inline
 * raw user-supplied strings — every dynamic segment runs through
 * {@link escapeHtml}.
 */
function buildHtmlBody(
  ownerName: string,
  leads: DueLead[],
  baseUrl: string | null,
): string {
  const items = leads
    .map((lead) => {
      const nameSafe = escapeHtml(lead.name);
      const companySafe =
        lead.company !== null && lead.company.length > 0
          ? ` (${escapeHtml(lead.company)})`
          : '';
      const dateSafe = escapeHtml(formatFollowUpDate(lead.nextFollowUpAt));

      const linkedName =
        baseUrl !== null
          ? `<a href="${escapeHtml(baseUrl)}/leads/${escapeHtml(lead.id)}">${nameSafe}</a>`
          : nameSafe;

      return `<li>${linkedName}${companySafe} &mdash; Follow up by ${dateSafe}</li>`;
    })
    .join('');

  return [
    `<p>Hi ${escapeHtml(ownerName)},</p>`,
    `<p>You have ${leads.length} follow-up${leads.length === 1 ? '' : 's'} due:</p>`,
    `<ul>${items}</ul>`,
    `<p>Open OfficePilot to action or reschedule them.</p>`,
  ].join('');
}

/**
 * Plain-text fallback for clients that strip HTML. Mirrors the HTML
 * body's structure so the information density is the same.
 */
function buildTextBody(
  ownerName: string,
  leads: DueLead[],
  baseUrl: string | null,
): string {
  const lines = leads.map((lead) => {
    const company =
      lead.company !== null && lead.company.length > 0 ? ` (${lead.company})` : '';
    const date = formatFollowUpDate(lead.nextFollowUpAt);
    const link = baseUrl !== null ? ` ${baseUrl}/leads/${lead.id}` : '';
    return `- ${lead.name}${company} - Follow up by ${date}${link}`;
  });

  return [
    `Hi ${ownerName},`,
    '',
    `You have ${leads.length} follow-up${leads.length === 1 ? '' : 's'} due:`,
    '',
    ...lines,
    '',
    'Open OfficePilot to action or reschedule them.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// POST /api/cron/followup-reminders
// ---------------------------------------------------------------------------

/**
 * Per-owner failure shape returned in the response `errors[]` array.
 *
 *   - `ownerId` is the offending `User.id` (or `null` when the lead
 *     had no owner / no email).
 *   - `message` is a short human-readable reason (`"missing email"`,
 *     `"smtp send failed: …"`).
 */
interface FollowupError {
  ownerId: string | null;
  message: string;
}

/**
 * Cron entry point. Bearer-authenticated, never returns owner data
 * (just counts + errors) so the scheduler can log the response
 * without leaking PII.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    // -- 1. Resolve and validate the bearer token. -------------------------
    //
    // `CRON_SECRET` is required: without one we can't verify anyone, so
    // the safe default is a hard 500 (loud failure, easy to spot in
    // monitoring) rather than silently accepting all callers.
    const expected = process.env.CRON_SECRET;
    if (expected === undefined || expected.length === 0) {
      // eslint-disable-next-line no-console
      console.error(
        '[api/cron/followup-reminders] CRON_SECRET is not configured',
      );
      return NextResponse.json(
        { error: 'server_error', message: 'Cron secret not configured' },
        { status: 500 },
      );
    }

    const provided = extractBearerToken(req.headers.get('authorization'));
    if (provided === null || !safeStringEqual(provided, expected)) {
      return NextResponse.json(
        { error: 'unauthorized', message: 'Invalid bearer token' },
        { status: 401 },
      );
    }

    // -- 2. Find all due / overdue leads. ----------------------------------
    //
    // `lte: new Date()` covers both "due today" (nextFollowUpAt earlier
    // today) and "overdue" (nextFollowUpAt yesterday and prior). The
    // status filter excludes leads that have already been resolved —
    // there's nothing to follow up on a CONVERTED or LOST lead, and
    // sending such reminders would just train owners to ignore the
    // digest.
    const now = new Date();
    const dueLeads: DueLead[] = await prisma.lead.findMany({
      where: {
        nextFollowUpAt: { lte: now },
        status: { notIn: ['CONVERTED', 'LOST'] },
      },
      include: {
        owner: {
          select: { id: true, name: true, email: true },
        },
      },
      orderBy: { nextFollowUpAt: 'asc' },
    });

    // -- 3. Group by owner email. ------------------------------------------
    //
    // Leads with no owner (or whose owner has no email) are recorded
    // in `errors[]` with `ownerId: null` so an admin can fix the data
    // without us silently dropping the reminder.
    const errors: FollowupError[] = [];
    const groups = new Map<
      string,
      { owner: { id: string; name: string; email: string }; leads: DueLead[] }
    >();

    for (const lead of dueLeads) {
      const owner = lead.owner;
      if (owner === null) {
        errors.push({
          ownerId: null,
          message: `lead ${lead.id} has no owner`,
        });
        continue;
      }
      // `email` is non-nullable in the User schema, but defensively
      // treat empty/whitespace-only strings as "missing" — sending to
      // such an address would surface as a confusing SMTP error.
      if (owner.email.trim().length === 0) {
        errors.push({
          ownerId: owner.id,
          message: `owner ${owner.id} has no email on file`,
        });
        continue;
      }

      const key = owner.email;
      const existing = groups.get(key);
      if (existing === undefined) {
        groups.set(key, { owner, leads: [lead] });
      } else {
        existing.leads.push(lead);
      }
    }

    // -- 4. Send one digest per owner. -------------------------------------
    //
    // Resolve `NEXTAUTH_URL` once; an empty value means "no link" and
    // the body falls back to plain lead names. Trim trailing slashes
    // so `${baseUrl}/leads/${id}` doesn't produce a double-slash.
    const rawBase = process.env.NEXTAUTH_URL;
    const baseUrl =
      rawBase !== undefined && rawBase.trim().length > 0
        ? rawBase.trim().replace(/\/+$/, '')
        : null;

    let ownersNotified = 0;
    let leadsCovered = 0;

    for (const { owner, leads } of groups.values()) {
      const subject = `OfficePilot: ${leads.length} follow-up${
        leads.length === 1 ? '' : 's'
      } due`;
      const html = buildHtmlBody(owner.name, leads, baseUrl);
      const text = buildTextBody(owner.name, leads, baseUrl);

      try {
        await sendMail({ to: owner.email, subject, html, text });
        ownersNotified += 1;
        leadsCovered += leads.length;
      } catch (sendErr) {
        const message =
          sendErr instanceof Error ? sendErr.message : 'unknown send error';
        // eslint-disable-next-line no-console
        console.error(
          `[api/cron/followup-reminders] failed to email owner ${owner.id}`,
          sendErr,
        );
        errors.push({
          ownerId: owner.id,
          message: `smtp send failed: ${message}`,
        });
      }
    }

    return NextResponse.json(
      {
        ok: true,
        ownersNotified,
        leadsCovered,
        errors,
      },
      { status: 200 },
    );
  } catch (err) {
    return errorResponse(err);
  }
}
