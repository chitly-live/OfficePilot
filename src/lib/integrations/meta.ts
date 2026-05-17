/**
 * Meta Marketing API integration helpers (Facebook + Instagram via the
 * same Meta Business app).
 *
 * v0.1.3 scope is **credential plumbing only**: we read the encrypted
 * access token and the public IDs out of the `Setting` table, and we
 * provide a single "test connection" pingback that the admin Settings
 * UI calls to confirm the credentials are well-formed and the token
 * hasn't expired. No campaign / insight syncing happens here yet.
 *
 * Wiring the actual `/insights` sync (campaign spend, signups, ROAS)
 * lives in v0.1.4 — see the TODO in `resolveMetaConfig` below.
 *
 * Keys read (per `@/lib/schemas/settings`):
 *
 *   • `meta_access_token`     — SENSITIVE (AES-256-GCM at rest).
 *   • `meta_ad_account_id`    — public, format `act_<digits>`.
 *   • `meta_business_id`      — optional, public.
 *
 * Network:
 *   • `testMetaConnection` issues a single GET to
 *     `https://graph.facebook.com/v18.0/me?access_token=...` with a
 *     10-second timeout. On 200 it surfaces the principal's display
 *     name so the operator can confirm "yes, this is the right
 *     account". On non-200 it returns Meta's `error.message`
 *     verbatim — the API reliably explains what went wrong (expired
 *     token, missing scope, throttled, etc.) and re-wording the
 *     diagnostic would only obscure it.
 *
 * The module is pure-ish: `resolveMetaConfig` reads from Prisma but
 * does no network I/O; `testMetaConnection` does network I/O against a
 * caller-supplied config (so unit tests can stub the config rather
 * than the DB layer).
 */

import { prisma } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Meta Graph API base URL. Pinned to a stable version per Meta's
 *  versioning policy — v18.0 (released 2023-09) is supported through
 *  September 2025 + 2 years; we'll bump this together with the v0.1.4
 *  sync wiring. */
const META_GRAPH_API_BASE = 'https://graph.facebook.com/v18.0' as const;

/** Network timeout for the "test connection" pingback. Meta's `/me`
 *  endpoint typically responds in <300 ms; 10s is a comfortable cap
 *  that absorbs cold-DNS / routing hiccups without making the admin
 *  UI feel hung. */
const META_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Plaintext Meta credentials, ready to use in API calls. `accessToken`
 * is decrypted out of the `Setting` table at resolve time — never
 * stored long-term in this shape.
 */
export interface MetaConfig {
  /** Long-lived (system user) access token. Plaintext at this point. */
  accessToken: string;
  /** Canonical Ad Account ID in `act_<digits>` form. */
  adAccountId: string;
  /** Optional Business Manager ID (`<digits>`). */
  businessId?: string;
}

/** Discriminated result of {@link testMetaConnection}. */
export type MetaConnectionTestResult =
  | { ok: true; meName: string }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// resolveMetaConfig
// ---------------------------------------------------------------------------

/**
 * Pull the three Meta-related `Setting` rows out of the DB, decrypt the
 * access token, and return a usable {@link MetaConfig}. Returns `null`
 * when any required field is missing or the stored token cannot be
 * decrypted — the caller is expected to surface a "config incomplete"
 * error to the operator in that case.
 *
 * `meta_business_id` is treated as optional: when absent or empty,
 * `businessId` is omitted from the returned object so it doesn't
 * round-trip to API calls as a literal `''`.
 *
 * TODO(v0.1.4): wire up Meta /insights sync — pass this config to the
 * spend / signup fetcher that v0.1.4 introduces.
 */
export async function resolveMetaConfig(): Promise<MetaConfig | null> {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: ['meta_access_token', 'meta_ad_account_id', 'meta_business_id'],
      },
    },
    select: { key: true, value: true },
  });

  const byKey = new Map<string, string>();
  for (const row of rows) {
    byKey.set(row.key, row.value);
  }

  const encryptedToken = byKey.get('meta_access_token');
  const adAccountId = byKey.get('meta_ad_account_id');
  const businessIdRaw = byKey.get('meta_business_id');

  // Required fields: token + Ad Account ID. Empty strings count as
  // missing — the PATCH handler accepts `""` to clear a value, so a
  // present-but-empty row is semantically "not configured".
  if (
    encryptedToken === undefined ||
    encryptedToken.length === 0 ||
    adAccountId === undefined ||
    adAccountId.length === 0
  ) {
    return null;
  }

  let accessToken: string;
  try {
    accessToken = decrypt(encryptedToken);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[meta] failed to decrypt access token', err);
    return null;
  }

  const config: MetaConfig = { accessToken, adAccountId };
  if (businessIdRaw !== undefined && businessIdRaw.length > 0) {
    config.businessId = businessIdRaw;
  }
  return config;
}

// ---------------------------------------------------------------------------
// testMetaConnection
// ---------------------------------------------------------------------------

/**
 * Issue a GET to Meta's `/me` endpoint to verify the access token
 * works. On 200 with `{ id, name }`, returns `{ ok: true, meName }`
 * so the caller can show the admin which Meta principal (page / user
 * / system user) the token belongs to. On any non-200, returns
 * `{ ok: false, error }` where `error` is Meta's `error.message` if
 * available, otherwise a generic transport-level diagnostic.
 *
 * Network errors (DNS, ECONNRESET, timeout) are caught and surfaced
 * as `{ ok: false, error: 'Network error: ...' }` so the caller never
 * has to deal with a thrown exception from this function.
 *
 * @param config decrypted Meta credentials; the `adAccountId` and
 *               `businessId` fields are not used by `/me` but are
 *               included in the type so a future expansion (probe the
 *               Ad Account directly) doesn't change the signature.
 */
export async function testMetaConnection(
  config: MetaConfig,
): Promise<MetaConnectionTestResult> {
  const url = new URL(`${META_GRAPH_API_BASE}/me`);
  url.searchParams.set('access_token', config.accessToken);
  url.searchParams.set('fields', 'id,name');

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: 'GET',
      // Built-in 10s timeout so a hung Meta endpoint doesn't pin the
      // admin's "Test connection" button forever.
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Request to Meta timed out after 10 seconds'
        : err instanceof Error
          ? `Network error: ${err.message}`
          : 'Network error contacting Meta';
    return { ok: false, error: message };
  }

  // Parse the body either way — Meta returns the same JSON envelope
  // shape on success (`{ id, name, ... }`) and failure (`{ error: {
  // message, type, code, ... } }`).
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      error: `Meta returned ${response.status} with an unparseable body`,
    };
  }

  if (!response.ok) {
    // Meta's standard error envelope:
    //   { error: { message, type, code, fbtrace_id, ... } }
    const metaError = extractMetaErrorMessage(body);
    return {
      ok: false,
      error: metaError ?? `Meta returned HTTP ${response.status}`,
    };
  }

  // Success — pluck `name` (display name of the token's principal).
  // Fall back to `id` if `name` is absent (a rare edge case for some
  // app-scoped tokens).
  const meName = extractMetaName(body);
  if (meName === null) {
    return {
      ok: false,
      error: 'Meta returned 200 but no `name` field — unexpected response',
    };
  }
  return { ok: true, meName };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pull `error.message` out of Meta's standard error envelope, returning
 *  `null` if the body is not in the expected shape. */
function extractMetaErrorMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const errorField = (body as { error?: unknown }).error;
  if (typeof errorField !== 'object' || errorField === null) return null;
  const message = (errorField as { message?: unknown }).message;
  return typeof message === 'string' && message.length > 0 ? message : null;
}

/** Pull `name` (or `id` as a fallback) out of a Meta `/me` response. */
function extractMetaName(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as { name?: unknown; id?: unknown };
  if (typeof obj.name === 'string' && obj.name.length > 0) {
    return obj.name;
  }
  if (typeof obj.id === 'string' && obj.id.length > 0) {
    return obj.id;
  }
  return null;
}
