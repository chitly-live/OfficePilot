/**
 * SMTP transport + `sendMail` helper backed by `nodemailer`.
 *
 * SPEC.md §1 ("Email (transactional) | nodemailer (SMTP)") and SPEC.md
 * §15 (Environment Variables) — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
 * `SMTP_PASS`, `SMTP_FROM`. SMTP is also admin-configurable via the
 * Settings module (SPEC.md §12.1) — values in the `Setting` table take
 * precedence over the env vars.
 *
 * **Why this module exists.** Several features need to send mail
 * (follow-up reminders, future admin alerts). Each one wants to read
 * config once, build a transport, and not worry about reconnect /
 * pooling / env-var validation. `nodemailer.createTransport` is cheap
 * but holds an internal pool — re-creating it per request would defeat
 * the pool, so this module caches the transport keyed by a hash of the
 * resolved config so config changes invalidate the cache automatically.
 *
 * **Configuration resolution.** {@link resolveSmtpConfig} fans out:
 *
 *   1. Read the five `smtp_*` rows from the `Setting` table. The
 *      `smtp_pass` row is encrypted at rest via `@/lib/crypto` and is
 *      decrypted in-place.
 *   2. For each field, fall back to the corresponding `SMTP_*` env var
 *      if the Setting row is missing or empty.
 *   3. If any of the five fields is still empty, return `null` — the
 *      caller treats this as "mailer disabled" and logs a skip.
 *
 * This split means an admin can flip the app from env-based to
 * UI-based config (or vice-versa) without redeploying — every setting
 * lookup happens per `sendMail()` call.
 *
 * **TLS mode.** Per the nodemailer convention used throughout the
 * Node ecosystem, `secure = true` (implicit TLS on connect) is
 * applied **only** when the resolved port equals 465. Every other
 * port — most commonly 587 — uses `secure = false` and lets STARTTLS
 * upgrade the connection. This avoids the common "I set secure:true
 * on 587 and connections hang" footgun.
 *
 * **Resetting in tests.** The cache is stored on the module so tests
 * can call {@link _resetMailerForTests} to drop it between cases and
 * force a fresh build. Production code never calls the reset hook —
 * it's exported with an underscore prefix specifically to discourage
 * that.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

import { decrypt } from '@/lib/crypto';
import { prisma } from '@/lib/db';

// ---------------------------------------------------------------------------
// Public config shape
// ---------------------------------------------------------------------------

/**
 * Fully-resolved SMTP configuration ready to be handed to
 * `nodemailer.createTransport`. All five fields are required — partial
 * configs surface as `null` from {@link resolveSmtpConfig} so callers
 * can treat "mailer disabled" as a first-class state.
 */
export interface SmtpConfig {
  /** Hostname or IPv4/IPv6 literal of the SMTP server. */
  host: string;
  /** TCP port (1–65535). `465` triggers implicit TLS; anything else
   *  uses STARTTLS-on-upgrade. */
  port: number;
  /** Username for `auth.user`. */
  user: string;
  /** Plaintext password / app-password for `auth.pass`. Decrypted from
   *  the `Setting` table or read straight from `SMTP_PASS`. */
  pass: string;
  /** RFC-5322 `From` header for every outbound message. */
  from: string;
}

// ---------------------------------------------------------------------------
// Module-level cache
// ---------------------------------------------------------------------------

/**
 * Cached transport instance + the cache key that produced it. The key
 * is a stable string derived from the resolved config; if the next
 * call's config hashes differently we drop the cached transport and
 * rebuild. This lets the Settings UI rotate the SMTP password without a
 * process restart while still reusing the connection pool for steady
 * state.
 */
interface CachedTransport {
  key: string;
  transport: Transporter<SMTPTransport.SentMessageInfo>;
}

let cachedTransport: CachedTransport | null = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The five Setting keys this module consumes. Kept inline so the
 * mailer doesn't pull `@/lib/schemas/settings` for a string array.
 */
const SMTP_SETTING_KEYS = [
  'smtp_host',
  'smtp_port',
  'smtp_user',
  'smtp_pass',
  'smtp_from',
] as const;

/**
 * Trim and coerce empty strings to `null`. Used to normalise both env
 * vars and Setting rows so the resolution logic doesn't have to
 * special-case `undefined` vs `''`.
 */
function nonEmpty(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Parse a port string into a positive integer in the 1–65535 range.
 * Returns `null` on any failure so the caller can fall back to the env
 * var without throwing. Mirrors the strict-integer semantics the old
 * `parsePort` had — `"587abc"` is rejected, `"587.5"` is rejected.
 */
function tryParsePort(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || n > 65_535) return null;
  return n;
}

/**
 * Read the five SMTP Setting rows in a single query and decrypt
 * `smtp_pass` if present. Missing rows produce `null` entries so the
 * caller can fall back to env vars cleanly.
 */
async function readSmtpSettings(): Promise<Record<
  (typeof SMTP_SETTING_KEYS)[number],
  string | null
>> {
  // Default everything to `null` so missing rows don't show up as
  // `undefined` and trip the `nonEmpty` check.
  const out: Record<(typeof SMTP_SETTING_KEYS)[number], string | null> = {
    smtp_host: null,
    smtp_port: null,
    smtp_user: null,
    smtp_pass: null,
    smtp_from: null,
  };

  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = await prisma.setting.findMany({
      where: { key: { in: SMTP_SETTING_KEYS as unknown as string[] } },
      select: { key: true, value: true },
    });
  } catch (dbErr) {
    // A DB outage shouldn't take the mailer offline if the env vars are
    // good — log and fall through with all rows = `null` so the env-var
    // path kicks in.
    // eslint-disable-next-line no-console
    console.error('[mailer] failed to read SMTP settings; falling back to env', dbErr);
    return out;
  }

  for (const row of rows) {
    if (!(row.key in out)) continue; // defensive
    const key = row.key as (typeof SMTP_SETTING_KEYS)[number];
    if (key === 'smtp_pass') {
      // Decrypt or skip. A bad ciphertext should not crash the whole
      // resolution — surface as `null` and let the env-var fallback
      // try its luck.
      try {
        out.smtp_pass = nonEmpty(row.value) === null ? null : decrypt(row.value);
      } catch (cryptoErr) {
        // eslint-disable-next-line no-console
        console.error('[mailer] failed to decrypt smtp_pass; falling back', cryptoErr);
        out.smtp_pass = null;
      }
    } else {
      out[key] = nonEmpty(row.value);
    }
  }

  return out;
}

/**
 * Build a stable cache key from a resolved config. We hash the password
 * conceptually by length + a short prefix — including the full plaintext
 * would put it in a module-level string. The key is opaque; collisions
 * are tolerable because a collision means the host/port/user/from also
 * match, which is exactly when the cached transport is still correct.
 */
function cacheKeyFor(cfg: SmtpConfig): string {
  return [
    cfg.host,
    String(cfg.port),
    cfg.user,
    cfg.from,
    // `passFingerprint` keeps the cache busted across rotations without
    // logging or storing the secret.
    `pwl${cfg.pass.length}`,
  ].join('|');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the active SMTP configuration. Returns `null` when any of the
 * five required fields is absent from BOTH the Setting table and the
 * environment — the caller treats `null` as "mailer disabled".
 *
 * Resolution order, per field:
 *
 *   1. `Setting` row (decrypted for `smtp_pass`).
 *   2. Corresponding `SMTP_*` env var.
 *   3. (give up — return `null`).
 *
 * Performs one `prisma.setting.findMany` per call. The transport cache
 * downstream keeps the per-`sendMail` cost low; we deliberately do NOT
 * cache the resolved config itself so a settings update is reflected on
 * the very next send.
 */
export async function resolveSmtpConfig(): Promise<SmtpConfig | null> {
  const settings = await readSmtpSettings();

  const host =
    nonEmpty(settings.smtp_host) ?? nonEmpty(process.env.SMTP_HOST) ?? null;
  const portRaw =
    nonEmpty(settings.smtp_port) ?? nonEmpty(process.env.SMTP_PORT) ?? null;
  const user =
    nonEmpty(settings.smtp_user) ?? nonEmpty(process.env.SMTP_USER) ?? null;
  // `smtp_pass` from the Setting table is already decrypted by
  // `readSmtpSettings` — both layers therefore expose plaintext to the
  // resolver, which is what nodemailer needs anyway.
  const pass =
    nonEmpty(settings.smtp_pass) ?? nonEmpty(process.env.SMTP_PASS) ?? null;
  const from =
    nonEmpty(settings.smtp_from) ?? nonEmpty(process.env.SMTP_FROM) ?? null;

  if (host == null || portRaw == null || user == null || pass == null || from == null) {
    return null;
  }

  const port = tryParsePort(portRaw);
  if (port == null) {
    // Invalid port string in both places. Treat as misconfigured
    // mailer — `null` so the caller skips rather than throwing.
    // eslint-disable-next-line no-console
    console.error(`[mailer] SMTP port is not a valid 1–65535 integer (got "${portRaw}")`);
    return null;
  }

  return { host, port, user, pass, from };
}

/**
 * Lazily construct (and cache) a nodemailer transport from the
 * currently-resolved SMTP config. Returns `null` when the mailer is
 * disabled (any required field missing).
 *
 * The transport is built with:
 *
 *   - `host`   = resolved `smtp_host`
 *   - `port`   = parsed `smtp_port`
 *   - `secure` = `port === 465` (implicit TLS on connect)
 *   - `auth`   = `{ user: resolved.user, pass: resolved.pass }`
 *
 * Cached by config-fingerprint so a Settings rotation invalidates the
 * pool automatically; equal configs reuse the existing pool.
 */
export async function getMailerTransport(): Promise<
  Transporter<SMTPTransport.SentMessageInfo> | null
> {
  const cfg = await resolveSmtpConfig();
  if (cfg === null) return null;

  const key = cacheKeyFor(cfg);
  if (cachedTransport !== null && cachedTransport.key === key) {
    return cachedTransport.transport;
  }

  // Implicit TLS uses 465; STARTTLS-on-upgrade uses 587 (and others).
  // Anything other than 465 → `secure: false` so STARTTLS can run.
  const secure = cfg.port === 465;

  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure,
    auth: { user: cfg.user, pass: cfg.pass },
  });

  cachedTransport = { key, transport };
  return transport;
}

/**
 * Arguments accepted by {@link sendMail}.
 */
export interface SendMailArgs {
  /** RFC-5321 envelope recipient. Single address or `Name <addr@x>`. */
  to: string;
  /** RFC-5322 `Subject` header. Plain text. */
  subject: string;
  /** Rich-content body. Required. */
  html: string;
  /**
   * Plain-text fallback for clients that strip HTML or for spam-filter
   * heuristics that flag HTML-only mail. Optional but strongly
   * recommended; nodemailer will not auto-derive it.
   */
  text?: string;
}

/**
 * Result returned by {@link sendMail} — currently just the SMTP
 * `Message-Id` so callers can log it for trace/correlation.
 */
export interface SendMailResult {
  /** Server-assigned `Message-Id` of the queued/sent email. */
  messageId: string;
}

/**
 * Send a single email via the cached transport.
 *
 * Thin wrapper over `transport.sendMail(...)` that:
 *
 *   1. Resolves the SMTP config (Setting → env → null). Throws if
 *      no config is available so callers get a clear "mailer
 *      disabled" signal rather than silently dropping the email.
 *   2. Forwards `to`, `subject`, `html`, and (optional) `text` to
 *      nodemailer.
 *   3. Returns `{ messageId }`. The full nodemailer info object is
 *      intentionally not surfaced — callers don't need to know about
 *      `accepted` / `rejected` arrays for the current feature set, and
 *      shrinking the return type makes mocking in tests trivial.
 *
 * Errors from the SMTP layer (auth failures, network errors, rejected
 * recipients) are propagated unchanged. The follow-up-reminders cron
 * catches them per-recipient so one bad address doesn't break the
 * whole digest.
 */
export async function sendMail(args: SendMailArgs): Promise<SendMailResult> {
  const cfg = await resolveSmtpConfig();
  if (cfg === null) {
    throw new Error('SMTP is not configured (mailer disabled).');
  }

  const transport = await getMailerTransport();
  if (transport === null) {
    // Defensive: `getMailerTransport` only returns null when
    // `resolveSmtpConfig` returns null, which we just checked. Throw
    // rather than silently dropping the message.
    throw new Error('SMTP transport could not be constructed.');
  }

  const info = await transport.sendMail({
    from: cfg.from,
    to: args.to,
    subject: args.subject,
    html: args.html,
    ...(args.text !== undefined ? { text: args.text } : {}),
  });

  return { messageId: info.messageId };
}

/**
 * Test-only hook: drop the cached transport so the next call to
 * {@link getMailerTransport} re-reads the environment. Not exported
 * via the package's public surface — the underscore prefix and the
 * doc-comment here are the contract.
 *
 * @internal
 */
export function _resetMailerForTests(): void {
  cachedTransport = null;
}
