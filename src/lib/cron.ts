/**
 * Cron worker helpers (pure — no scheduling side effects).
 *
 * SPEC.md §10.6 ("Cron jobs") and §17.3 (PM2 ecosystem). The Next.js
 * app runs as one PM2 cluster app (`officepilot-web`). A second PM2
 * fork-mode app (`officepilot-cron` — task 101) imports the helpers
 * here and `worker/index.ts` to schedule the two cron endpoints:
 *
 *   • `POST /api/cron/daily-digest`        — SPEC §10.6, task 71
 *   • `POST /api/cron/followup-reminders`  — SPEC §6.2.5, task 72
 *
 * Both endpoints are bearer-gated by `CRON_SECRET`. The worker holds
 * that secret in process env and forwards it on every call.
 *
 * **Why split helpers vs worker entry?** The worker entry
 * (`worker/index.ts`) starts an event loop that lives forever; that
 * makes it awkward to unit-test. The functions here are pure: they
 * read settings / build a cron string / `fetch` an HTTP endpoint, and
 * each one is independently testable. The worker just composes them.
 *
 * **Timezone.** SPEC §10.6 says "Runs at 9:00 AM IST". `node-cron`
 * accepts a `timezone` option per task; we resolve it once via
 * {@link getCronTimezone} and pass it to every `schedule()` call so a
 * cron expression like `'0 9 * * *'` fires at 09:00 in `Asia/Kolkata`
 * regardless of the host's TZ.
 */

import { prisma } from './db';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hour of day to use when no `Setting` row is configured. SPEC §17.3
 * example shows the digest fires at 09:00 IST; matching the seed
 * default `Setting('daily_digest_hour') = '9'` (see `prisma/seed.ts`).
 */
const DEFAULT_HOUR = 9;

/**
 * Default timezone for cron scheduling. SPEC §10.6 — "9 AM IST".
 * Overridable at deploy time via the `CRON_TIMEZONE` env var without
 * touching the codebase.
 */
const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * Default base URL the worker uses when calling cron endpoints. The
 * worker runs on the same host as the web app (PM2 manages both per
 * SPEC §17.3), so localhost on port 3000 is the right default.
 */
const DEFAULT_BASE_URL = 'http://localhost:3000';

// ---------------------------------------------------------------------------
// Setting helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `Setting.value` string into an hour-of-day in 0..23. Returns
 * `null` when the value is missing, blank, non-numeric, fractional, or
 * outside the valid range — callers fall back to {@link DEFAULT_HOUR}.
 *
 * We accept both whitespace-padded and bare numbers because settings
 * are admin-edited free text and a stray space shouldn't push us to
 * the fallback hour silently.
 */
function parseHour(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // Number(trimmed) is intentional over parseInt — we want to reject
  // values like "9.5" (parseInt would happily return 9) and "9abc"
  // (parseInt would return 9; Number returns NaN).
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < 0 || parsed > 23) return null;
  return parsed;
}

/**
 * Look up a `Setting` row by key and parse it as an hour. Wraps the
 * Prisma call in a try/catch so a transient DB hiccup at worker
 * startup degrades gracefully to the default hour rather than
 * crashing the worker process.
 *
 * @param key The `Setting.key` to read (e.g. `'daily_digest_hour'`).
 * @returns The parsed hour 0..23, or `null` when missing/invalid.
 */
async function readHourSetting(key: string): Promise<number | null> {
  try {
    const row = await prisma.setting.findUnique({ where: { key } });
    if (row === null) return null;
    return parseHour(row.value);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[lib/cron] failed to read Setting('${key}'); using default`,
      err,
    );
    return null;
  }
}

/**
 * Build a daily cron expression that fires at `hour:00` every day.
 *
 * Expression layout:
 *
 *     ┌── minute (0)
 *     │  ┌── hour
 *     │  │ ┌── day of month
 *     │  │ │ ┌── month
 *     │  │ │ │ ┌── day of week
 *     │  │ │ │ │
 *     0  9 * * *
 *
 * The result still has to be paired with a `timezone` option on the
 * `node-cron` task to anchor it to IST (see {@link getCronTimezone}).
 */
function dailyAt(hour: number): string {
  return `0 ${hour} * * *`;
}

// ---------------------------------------------------------------------------
// Public schedule resolvers
// ---------------------------------------------------------------------------

/**
 * Resolve the cron expression for the daily AI digest job.
 *
 * Looks up `Setting('daily_digest_hour')` (admin-editable from
 * `/settings`); falls back to {@link DEFAULT_HOUR} (9 AM) when the row
 * is missing, blank, or invalid. The returned expression is suitable
 * for `cron.schedule(expr, fn, { timezone })`.
 *
 * SPEC §10.6 — "Runs at 9:00 AM IST".
 */
export async function getDailyDigestSchedule(): Promise<string> {
  const hour = (await readHourSetting('daily_digest_hour')) ?? DEFAULT_HOUR;
  return dailyAt(hour);
}

/**
 * Resolve the cron expression for the follow-up reminder job.
 *
 * Reads `Setting('followup_reminder_hour')` first; if absent, falls
 * back to `Setting('daily_digest_hour')` so admins who only set the
 * digest hour get reminders at the same time. If neither row exists
 * (or both are invalid), defaults to {@link DEFAULT_HOUR} — matching
 * SPEC §6.2.5's "daily" cadence.
 */
export async function getFollowupReminderSchedule(): Promise<string> {
  const followupHour = await readHourSetting('followup_reminder_hour');
  if (followupHour !== null) return dailyAt(followupHour);

  const digestHour = await readHourSetting('daily_digest_hour');
  return dailyAt(digestHour ?? DEFAULT_HOUR);
}

/**
 * Resolve the timezone to anchor cron schedules against.
 *
 * Reads `process.env.CRON_TIMEZONE`; defaults to
 * {@link DEFAULT_TIMEZONE} (`'Asia/Kolkata'`) per SPEC §10.6.
 * Returned verbatim — `node-cron` accepts any IANA timezone string
 * and we don't second-guess admin overrides.
 */
export function getCronTimezone(): string {
  const fromEnv = process.env.CRON_TIMEZONE;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return DEFAULT_TIMEZONE;
}

// ---------------------------------------------------------------------------
// HTTP caller
// ---------------------------------------------------------------------------

/**
 * Result of a {@link callCronEndpoint} invocation.
 *
 *   • `ok`     — `Response.ok` (true for 2xx).
 *   • `status` — HTTP status code; `0` when the call never reached the
 *                server (DNS failure, connection refused, etc.).
 *   • `body`   — Raw response body; `null` when the call threw before
 *                a body was available, or when the body could not be
 *                read as text.
 */
export interface CronCallResult {
  ok: boolean;
  status: number;
  body: string | null;
}

/**
 * POST to a bearer-protected cron endpoint and return a structured
 * result.
 *
 * Logs to `console.info` on success and `console.error` on failure so
 * PM2's stdout / stderr capture (SPEC §17.3) gives operators a
 * timestamped trail of every fire.
 *
 * Never throws — network errors are returned as `{ ok: false, status:
 * 0, body: '<error message>' }` so the caller's cron task doesn't
 * crash the long-running worker on a transient blip. The retry-after-
 * 1h policy from SPEC §10.6 is implemented at a higher layer (the
 * worker schedules a one-shot retry).
 *
 * @param path     The endpoint path, starting with `/`
 *                 (e.g. `'/api/cron/daily-digest'`).
 * @param secret   The bearer token to send in the `Authorization`
 *                 header; comes from `process.env.CRON_SECRET`.
 * @param baseUrl  Optional override for the host. Defaults to
 *                 {@link DEFAULT_BASE_URL} (`http://localhost:3000`).
 *                 Trailing slashes are stripped so callers don't have
 *                 to be careful with their env values.
 */
export async function callCronEndpoint(
  path: string,
  secret: string,
  baseUrl?: string,
): Promise<CronCallResult> {
  const resolvedBase = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const url = `${resolvedBase}${path}`;
  const startedAt = Date.now();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      // Cron endpoints don't need a body, but some HTTP stacks dislike
      // POSTs with `Content-Length: 0` and no body at all. An empty
      // JSON object is the least surprising payload.
      body: '{}',
    });

    let body: string | null = null;
    try {
      body = await res.text();
    } catch {
      // The response was successful at the HTTP layer but the body
      // stream errored; surface that as `body: null` rather than
      // failing the whole call.
      body = null;
    }

    const elapsedMs = Date.now() - startedAt;
    if (res.ok) {
      // eslint-disable-next-line no-console
      console.info(
        `[lib/cron] ${path} → ${res.status} OK (${elapsedMs} ms)`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.error(
        `[lib/cron] ${path} → ${res.status} (${elapsedMs} ms)`,
        body ?? '<no body>',
      );
    }

    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const elapsedMs = Date.now() - startedAt;
    // eslint-disable-next-line no-console
    console.error(
      `[lib/cron] ${path} request failed after ${elapsedMs} ms:`,
      message,
    );
    return { ok: false, status: 0, body: message };
  }
}
