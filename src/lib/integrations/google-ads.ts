/**
 * Google Ads API integration helpers.
 *
 * v0.1.3 scope is **credential plumbing only**: we read the OAuth
 * credential set + developer token out of the `Setting` table and
 * provide a single "test connection" pingback that the admin Settings
 * UI calls to confirm the OAuth refresh token still works. The actual
 * Google Ads API (`googleads.googleapis.com`) is gRPC; wiring the
 * `searchStream` campaign fetcher belongs in v0.1.4 once we pull in
 * `google-ads-api` (or roll our own REST translator).
 *
 * Keys read (per `@/lib/schemas/settings`):
 *
 *   • `google_ads_developer_token`     — SENSITIVE.
 *   • `google_ads_customer_id`         — public, 10-digit canonical.
 *   • `google_ads_client_id`           — public OAuth client ID.
 *   • `google_ads_client_secret`       — SENSITIVE.
 *   • `google_ads_refresh_token`       — SENSITIVE.
 *   • `google_ads_login_customer_id`   — optional (MCC manager ID).
 *
 * "Test connection" rationale:
 *
 *   The Google Ads API itself requires the developer token to be
 *   approved (a manual application process that can take 1-3 weeks),
 *   and an active manager-account relationship. Until that approval
 *   lands the developer token is "test access" only, and even a
 *   well-formed call to `searchStream` is rejected.
 *
 *   What we CAN verify cheaply, with zero gRPC dependency, is the OAuth
 *   half: exchange the refresh token for an access token at the public
 *   `https://oauth2.googleapis.com/token` endpoint. A 200 confirms
 *   client_id + client_secret + refresh_token are mutually consistent
 *   and the user hasn't revoked the grant. That's exactly the failure
 *   mode the admin needs to detect at paste time — wrong credentials
 *   would prevent any future API call, approved or not.
 *
 * TODO(v0.1.4): wire up Google Ads /searchStream sync — the gRPC client
 * (`google-ads-api` package) needs the full triple plus the developer
 * token and the optional login_customer_id header for MCC accounts.
 */

import { prisma } from '@/lib/db';
import { decrypt } from '@/lib/crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Google's public OAuth2 token endpoint. Documented at
 *  https://developers.google.com/identity/protocols/oauth2#token */
const GOOGLE_OAUTH_TOKEN_URL =
  'https://oauth2.googleapis.com/token' as const;

/** Network timeout for the OAuth refresh probe. Google's token
 *  endpoint typically responds in <500 ms; 10s covers cold-DNS and
 *  occasional cross-region latency. */
const GOOGLE_ADS_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Plaintext Google Ads credentials, ready to use against the OAuth
 * endpoint and (in v0.1.4) the Ads API. Sensitive fields are decrypted
 * at resolve time and never stored long-term in this shape.
 */
export interface GoogleAdsConfig {
  /** Developer token from `ads.google.com/aw/apicenter`. */
  developerToken: string;
  /** 10-digit canonical customer ID (hyphens already stripped). */
  customerId: string;
  /** OAuth 2.0 client ID. */
  clientId: string;
  /** OAuth 2.0 client secret. */
  clientSecret: string;
  /** OAuth 2.0 refresh token (long-lived; never expires unless
   *  revoked). */
  refreshToken: string;
  /** Optional manager-account ID (MCC) used as the
   *  `login-customer-id` header when present. */
  loginCustomerId?: string;
}

/** Discriminated result of {@link testGoogleAdsConnection}. */
export type GoogleAdsConnectionTestResult =
  | { ok: true; refreshOk: true }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// resolveGoogleAdsConfig
// ---------------------------------------------------------------------------

/**
 * Pull the six Google-Ads-related `Setting` rows out of the DB,
 * decrypt the four sensitive ones, and return a usable
 * {@link GoogleAdsConfig}. Returns `null` when any required field is
 * missing or one of the encrypted blobs cannot be decrypted.
 *
 * `google_ads_login_customer_id` is optional: when absent or empty,
 * `loginCustomerId` is omitted from the returned object.
 */
export async function resolveGoogleAdsConfig(): Promise<GoogleAdsConfig | null> {
  const rows = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          'google_ads_developer_token',
          'google_ads_customer_id',
          'google_ads_client_id',
          'google_ads_client_secret',
          'google_ads_refresh_token',
          'google_ads_login_customer_id',
        ],
      },
    },
    select: { key: true, value: true },
  });

  const byKey = new Map<string, string>();
  for (const row of rows) {
    byKey.set(row.key, row.value);
  }

  // Required: developer token, customer ID, OAuth client (id+secret),
  // refresh token. Empty rows count as missing.
  const required = [
    'google_ads_developer_token',
    'google_ads_customer_id',
    'google_ads_client_id',
    'google_ads_client_secret',
    'google_ads_refresh_token',
  ] as const;
  for (const key of required) {
    const v = byKey.get(key);
    if (v === undefined || v.length === 0) {
      return null;
    }
  }

  // Decrypt sensitive fields. Wrapped in try/catch so a corrupted blob
  // (e.g. ENCRYPTION_KEY rotated without re-encrypting) doesn't take
  // the whole call down — we just refuse to return a config.
  let developerToken: string;
  let clientSecret: string;
  let refreshToken: string;
  try {
    // Non-null assertions are safe — we checked the `required` loop
    // above.
    developerToken = decrypt(byKey.get('google_ads_developer_token')!);
    clientSecret = decrypt(byKey.get('google_ads_client_secret')!);
    refreshToken = decrypt(byKey.get('google_ads_refresh_token')!);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google-ads] failed to decrypt credentials', err);
    return null;
  }

  const config: GoogleAdsConfig = {
    developerToken,
    customerId: byKey.get('google_ads_customer_id')!,
    clientId: byKey.get('google_ads_client_id')!,
    clientSecret,
    refreshToken,
  };

  const loginCustomerId = byKey.get('google_ads_login_customer_id');
  if (loginCustomerId !== undefined && loginCustomerId.length > 0) {
    config.loginCustomerId = loginCustomerId;
  }
  return config;
}

// ---------------------------------------------------------------------------
// testGoogleAdsConnection
// ---------------------------------------------------------------------------

/**
 * Exchange the stored refresh token for an access token at Google's
 * public OAuth endpoint. A 200 response confirms `client_id`,
 * `client_secret`, and `refresh_token` are mutually consistent and the
 * grant has not been revoked.
 *
 * This intentionally does NOT call the Google Ads API itself — that
 * needs a gRPC client (out of scope for v0.1.3), and would also fail
 * for accounts whose developer token approval is still pending.
 *
 * On 4xx, returns `{ ok: false, error: <error_description> }` from
 * Google's OAuth error envelope (`{ error, error_description, ... }`).
 * On network failure / timeout, returns a `{ ok: false }` with a
 * transport-level diagnostic.
 *
 * TODO(v0.1.4): once the gRPC client is in place, additionally hit
 * `customers/<id>/googleAds:searchStream` with a trivial query
 * (`SELECT customer.id FROM customer`) to verify the developer token
 * is approved and the customer ID is reachable.
 */
export async function testGoogleAdsConnection(
  config: GoogleAdsConfig,
): Promise<GoogleAdsConnectionTestResult> {
  // OAuth2 token endpoint expects an application/x-www-form-urlencoded
  // body — that's the documented contract, and using a Json body would
  // be silently rejected.
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token',
  });

  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(GOOGLE_ADS_TIMEOUT_MS),
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'TimeoutError'
        ? 'Request to Google timed out after 10 seconds'
        : err instanceof Error
          ? `Network error: ${err.message}`
          : 'Network error contacting Google';
    return { ok: false, error: message };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      error: `Google returned ${response.status} with an unparseable body`,
    };
  }

  if (!response.ok) {
    // Google's OAuth error envelope:
    //   { error: "invalid_grant", error_description: "Token has been..." }
    const description = extractOAuthErrorDescription(payload);
    return {
      ok: false,
      error: description ?? `Google returned HTTP ${response.status}`,
    };
  }

  // Success — we deliberately do NOT return the access token. It's a
  // short-lived (~1h) secret and the test endpoint has no reason to
  // expose it. The "refreshOk: true" flag is all the caller needs.
  return { ok: true, refreshOk: true };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Pull `error_description` (preferred) or `error` from Google's
 *  OAuth error envelope, returning `null` when the body is not in the
 *  expected shape. */
function extractOAuthErrorDescription(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const obj = body as { error_description?: unknown; error?: unknown };
  if (
    typeof obj.error_description === 'string' &&
    obj.error_description.length > 0
  ) {
    return obj.error_description;
  }
  if (typeof obj.error === 'string' && obj.error.length > 0) {
    return obj.error;
  }
  return null;
}
